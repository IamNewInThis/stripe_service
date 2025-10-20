import Stripe from 'stripe';
import dotenv from 'dotenv';
dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const MOBILE_STRIPE_API_VERSION = '2024-06-20';

export const createCheckoutSession = async (req, res) => {
    try {
        const { priceId, userId } = req.body;

        // Validaciones
        if (!priceId) {
            return res.status(400).json({ error: 'priceId is required' });
        }
        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [
                {
                    price: priceId, // ID del precio creado en el dashboard de Stripe
                    quantity: 1,
                },
            ],
            success_url: `${process.env.CLIENT_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CLIENT_URL}/cancel`,
            metadata: { userId },
            // Configurar cliente para asociar suscripción
            customer_email: req.body.email, // Opcional: puedes pasar el email del usuario
        });

        res.json({ 
            url: session.url,
            sessionId: session.id 
        });
    } catch (err) {
        console.error('Error creating checkout session:', err);
        res.status(500).json({ 
            error: 'Failed to create checkout session',
            message: err.message 
        });
    }
};

export const handleWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('⚠️  Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`📥 Received event: ${event.type}`);

    // Manejo de eventos
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            console.log(`✅ Checkout completado para usuario: ${session.metadata.userId}`);
            console.log(`   Session ID: ${session.id}`);
            console.log(`   Customer: ${session.customer}`);
            // TODO: Aquí deberías actualizar tu base de datos (Supabase)
            // para activar la suscripción del usuario
            break;

        case 'customer.subscription.created':
            const subscription = event.data.object;
            console.log(`📝 Suscripción creada: ${subscription.id}`);
            // TODO: Guardar suscripción en base de datos
            break;

        case 'customer.subscription.updated':
            const updatedSubscription = event.data.object;
            console.log(`🔄 Suscripción actualizada: ${updatedSubscription.id}`);
            // TODO: Actualizar estado de suscripción en base de datos
            break;

        case 'customer.subscription.deleted':
            const deletedSubscription = event.data.object;
            console.log(`❌ Suscripción cancelada: ${deletedSubscription.id}`);
            // TODO: Desactivar suscripción en base de datos
            break;

        case 'invoice.payment_succeeded':
            const invoice = event.data.object;
            console.log(`💰 Pago exitoso para factura: ${invoice.id}`);
            break;

        case 'invoice.payment_failed':
            const failedInvoice = event.data.object;
            console.log(`⚠️  Pago fallido para factura: ${failedInvoice.id}`);
            // TODO: Notificar al usuario sobre el pago fallido
            break;

        default:
            console.log(`ℹ️  Evento no manejado: ${event.type}`);
    }

    res.json({ received: true });
};

export const getSubscriptionStatus = async (req, res) => {
    try {
        const { customerId } = req.params;

        if (!customerId) {
            return res.status(400).json({ error: 'customerId is required' });
        }

        const subscriptions = await stripe.subscriptions.list({
            customer: customerId,
            status: 'all',
            limit: 1,
        });

        if (subscriptions.data.length === 0) {
            return res.json({ 
                hasSubscription: false,
                message: 'No active subscription found' 
            });
        }

        const subscription = subscriptions.data[0];
        
        res.json({
            hasSubscription: true,
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            subscription: subscription
        });
    } catch (err) {
        console.error('Error getting subscription status:', err);
        res.status(500).json({ 
            error: 'Failed to get subscription status',
            message: err.message 
        });
    }
};

export const cancelSubscription = async (req, res) => {
    try {
        const { subscriptionId } = req.params;

        if (!subscriptionId) {
            return res.status(400).json({ error: 'subscriptionId is required' });
        }

        const subscription = await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true,
        });

        res.json({
            message: 'Subscription will be cancelled at period end',
            subscription: subscription
        });
    } catch (err) {
        console.error('Error cancelling subscription:', err);
        res.status(500).json({ 
            error: 'Failed to cancel subscription',
            message: err.message 
        });
    }
};

/**
 * Crear PaymentIntent para pagos nativos en React Native
 * Compatible con Google Pay, Apple Pay y tarjetas
 */
export const createPaymentSheetSession = async (req, res) => {
    try {
        const { amount, currency = 'usd', userId, email, description, metadata = {} } = req.body;

        // Validaciones
        if (!amount) {
            return res.status(400).json({ error: 'amount is required' });
        }

        if (amount < 50) {
            return res.status(400).json({ 
                error: 'amount must be at least 50 cents (0.50 USD)' 
            });
        }

        const normalizedCurrency = currency.toLowerCase();
        const customerMetadata = {
            ...(userId ? { userId } : {}),
        };
        const paymentMetadata = {
            ...(userId ? { userId } : { userId: 'guest' }),
            ...metadata,
        };

        let customer;

        if (userId) {
            try {
                const existingCustomers = await stripe.customers.search({
                    query: `metadata['userId']:'${userId}'`,
                    limit: 1,
                });

                if (existingCustomers.data.length > 0) {
                    customer = existingCustomers.data[0];

                    if (email && !customer.email) {
                        await stripe.customers.update(customer.id, { email });
                    }
                }
            } catch (searchError) {
                console.warn('⚠️  Stripe customer search failed, creating new customer:', searchError.message);
            }
        }

        if (!customer) {
            customer = await stripe.customers.create({
                email,
                metadata: customerMetadata,
            });
        }

        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: customer.id },
            { apiVersion: MOBILE_STRIPE_API_VERSION }
        );

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount), // Asegurar que sea entero
            currency: normalizedCurrency,
            customer: customer.id,
            description: description || 'Lumi Payment',
            automatic_payment_methods: {
                enabled: true,
            },
            metadata: paymentMetadata,
        });

        console.log(`💳 PaymentIntent creado: ${paymentIntent.id} - Amount: ${amount} ${normalizedCurrency}`);

        res.json({
            paymentIntent: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
            ephemeralKey: ephemeralKey.secret,
            customer: customer.id,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
        });
    } catch (err) {
        console.error('Error creating payment sheet session:', err);
        res.status(500).json({
            error: 'Failed to create payment sheet session',
            message: err.message
        });
    }
};

// @TODO: Agregar metodo de create subscripcion, con create client, primero se debe crear el cliente en stripe en caso de no existir,
// Si existe el cliente, se selecciona el id del cliente de stripe, luego se crea la subscripcion con el id del cliente
// Luego se debe crear los registros en supabase tabla subscriptions y payments
