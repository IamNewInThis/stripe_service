import Stripe from 'stripe';
import dotenv from 'dotenv';
dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const MOBILE_STRIPE_API_VERSION = '2024-06-20';
const PRICE_IDS = {
    monthly: process.env.STRIPE_PRICE_ID_MONTHLY,
};

const resolvePriceId = (planId, priceId) => {
    if (priceId) {
        return priceId;
    }

    if (!planId) {
        throw new Error('planId or priceId is required');
    }

    const resolved = PRICE_IDS[planId];
    if (!resolved) {
        throw new Error(`Price ID not configured for plan '${planId}'`);
    }
    return resolved;
};

const buildCustomerMetadata = (userId, metadata = {}) => ({
    ...(userId ? { userId } : {}),
    ...metadata,
});

const extractInvoiceId = (invoice) => {
    if (!invoice) return null;
    if (typeof invoice === 'string') return invoice;
    if (invoice.id) return invoice.id;
    return null;
};

const ensureCustomerMetadata = async (customer, { email, userId }) => {
    const needsUpdate =
        (email && customer.email !== email) ||
        (userId && customer.metadata?.userId !== userId);

    if (needsUpdate) {
        await stripe.customers.update(customer.id, {
            ...(email ? { email } : {}),
            metadata: {
                ...(customer.metadata || {}),
                ...(userId ? { userId } : {}),
            },
        });
    }

    return stripe.customers.retrieve(customer.id);
};

const findOrCreateCustomer = async ({ userId, email }) => {
    let customer = null;

    if (userId) {
        try {
            const existingCustomers = await stripe.customers.search({
                query: `metadata['userId']:'${userId}'`,
                limit: 1,
            });

            if (existingCustomers.data.length > 0) {
                customer = existingCustomers.data[0];
            }
        } catch (searchError) {
            console.warn('⚠️  Stripe customer search failed, creating new customer:', searchError.message);
        }
    }

    if (!customer) {
        customer = await stripe.customers.create({
            email,
            metadata: buildCustomerMetadata(userId),
        });
    } else {
        customer = await ensureCustomerMetadata(customer, { email, userId });
    }

    return customer;
};

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
                    price: priceId,
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
 * Prepara sesión para SetupIntent + PaymentSheet (guardar método de pago)
 */
export const createSubscriptionSession = async (req, res) => {
    try {
        const { planId, priceId: priceIdOverride, userId, email, metadata = {} } = req.body;

        let priceId;
        try {
            priceId = resolvePriceId(planId, priceIdOverride);
        } catch (resolveError) {
            return res.status(400).json({ error: resolveError.message });
        }

        const customer = await findOrCreateCustomer({ userId, email });
        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: customer.id },
            { apiVersion: MOBILE_STRIPE_API_VERSION }
        );

        const setupIntent = await stripe.setupIntents.create({
            customer: customer.id,
            automatic_payment_methods: { enabled: true },
            metadata: buildCustomerMetadata(userId, { planId, ...metadata }),
        });

        res.json({
            customerId: customer.id,
            customerEmail: customer.email,
            customerEphemeralKeySecret: ephemeralKey.secret,
            setupIntentClientSecret: setupIntent.client_secret,
            priceId,
            planId,
        });
    } catch (err) {
        console.error('Error creating subscription session:', err);
        res.status(500).json({
            error: 'Failed to create subscription session',
            message: err.message,
        });
    }
};

/**
 * Crea la suscripción en Stripe y prepara el PaymentIntent de la primera factura
 */
export const createSubscription = async (req, res) => {
    try {
        const {
            customerId,
            planId,
            priceId: priceIdOverride,
            userId,
            email,
            setupIntentId,
            metadata = {},
        } = req.body;

        if (!customerId) {
            return res.status(400).json({ error: 'customerId is required' });
        }

        let priceId;
        try {
            priceId = resolvePriceId(planId, priceIdOverride);
        } catch (resolveError) {
            return res.status(400).json({ error: resolveError.message });
        }

        const customer = await ensureCustomerMetadata(
            await stripe.customers.retrieve(customerId),
            { email, userId }
        );

        const paymentEphemeralKey = await stripe.ephemeralKeys.create(
            { customer: customer.id },
            { apiVersion: MOBILE_STRIPE_API_VERSION }
        );

        let defaultPaymentMethodId = null;

        if (setupIntentId) {
            try {
                const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
                defaultPaymentMethodId = setupIntent.payment_method || null;
            } catch (setupIntentError) {
                console.warn('⚠️  Unable to retrieve setup intent for default payment method:', setupIntentError.message);
            }
        }

        if (!defaultPaymentMethodId) {
            try {
                const paymentMethods = await stripe.paymentMethods.list({
                    customer: customer.id,
                    type: 'card',
                    limit: 1,
                });
                defaultPaymentMethodId = paymentMethods.data[0]?.id || null;
            } catch (paymentMethodsError) {
                console.warn('⚠️  Unable to list customer payment methods:', paymentMethodsError.message);
            }
        }
        
        if (defaultPaymentMethodId) {
            try {
                await stripe.customers.update(customer.id, {
                    invoice_settings: {
                        default_payment_method: defaultPaymentMethodId,
                    },
                });
            } catch (updateError) {
                console.warn('⚠️  Unable to set default payment method on customer:', updateError.message);
            }
        }

        let subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [
                {
                    price: priceId,
                },
            ],
            payment_behavior: 'default_incomplete',
            collection_method: 'charge_automatically',
            ...(defaultPaymentMethodId ? { default_payment_method: defaultPaymentMethodId } : {}),
            payment_settings: {
                save_default_payment_method: 'on_subscription',
                payment_method_types: ['card'],
            },
            expand: ['latest_invoice.payment_intent'],
            metadata: buildCustomerMetadata(userId, { planId, ...metadata }),
        });

        let paymentIntent = subscription.latest_invoice?.payment_intent || null;

        if (paymentIntent && typeof paymentIntent === 'string') {
            try {
                paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent);
            } catch (intentError) {
                console.warn('⚠️  Unable to expand payment intent directly:', intentError.message);
                paymentIntent = null;
            }
        }

        const latestInvoiceId = extractInvoiceId(subscription.latest_invoice);

        if ((!paymentIntent || !paymentIntent.client_secret) && latestInvoiceId) {
            try {
                const latestInvoice = await stripe.invoices.retrieve(latestInvoiceId, {
                    expand: ['payment_intent'],
                });
                paymentIntent = latestInvoice?.payment_intent || null;
            } catch (invoiceError) {
                console.warn('⚠️  Unable to retrieve subscription latest invoice:', invoiceError.message);
            }
        }

        let invoicePaymentStatus = null;

        if ((!paymentIntent || typeof paymentIntent === 'string') && latestInvoiceId && defaultPaymentMethodId) {
            try {
                const paidInvoice = await stripe.invoices.pay(latestInvoiceId, {
                    payment_method: defaultPaymentMethodId,
                });
                invoicePaymentStatus = paidInvoice.status;
                if (paidInvoice.payment_intent) {
                    paymentIntent =
                        typeof paidInvoice.payment_intent === 'string'
                            ? await stripe.paymentIntents.retrieve(paidInvoice.payment_intent)
                            : paidInvoice.payment_intent;
                }
            } catch (payError) {
                console.warn('⚠️  Unable to auto-pay invoice:', payError.message);
            }
        }

        subscription = await stripe.subscriptions.retrieve(subscription.id, {
            expand: ['latest_invoice.payment_intent'],
        });

        paymentIntent =
            paymentIntent ||
            (subscription.latest_invoice?.payment_intent && typeof subscription.latest_invoice.payment_intent === 'string'
                ? await stripe.paymentIntents.retrieve(subscription.latest_invoice.payment_intent)
                : subscription.latest_invoice?.payment_intent || null);

        const paymentIntentStatus = paymentIntent?.status || null;
        const requiresAction = paymentIntentStatus
            ? ['requires_action', 'requires_payment_method'].includes(paymentIntentStatus)
            : false;

        res.json({
            subscriptionId: subscription.id,
            subscriptionStatus: subscription.status,
            customerId: customer.id,
            planId,
            priceId,
            latestInvoiceId,
            paymentIntentId: paymentIntent?.id || null,
            paymentIntentStatus,
            paymentIntentClientSecret: paymentIntent?.client_secret || null,
            requiresAction,
            customerEphemeralKeySecret: paymentEphemeralKey.secret,
            invoiceStatus: invoicePaymentStatus || subscription.latest_invoice?.status || null,
        });
    } catch (err) {
        console.error('Error creating subscription:', err);
        res.status(500).json({
            error: 'Failed to create subscription',
            message: err.message,
        });
    }
};
