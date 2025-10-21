import Stripe from 'stripe';
import dotenv from 'dotenv';
dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const priceId = process.env.STRIPE_DEFAULT_PRICE_ID;
const MOBILE_STRIPE_API_VERSION = '2024-06-20';


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
            const subscriptionId = invoice.subscription;
            console.log(`✅ Suscripción ${subscriptionId} activada automáticamente`);
            // Aquí marcas al usuario como "suscrito" en tu BD
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
    const { userId, email, priceId: requestPriceId, metadata = {} } = req.body;

    // 🧩 Validaciones
    if (!email) {
      return res.status(400).json({ error: 'email is required to create or find customer' });
    }

    // Usar priceId del request o el default de las variables de entorno
    const subscriptionPriceId = requestPriceId || priceId;
    
    if (!subscriptionPriceId) {
      return res.status(400).json({ error: 'priceId is required for subscription' });
    }

    const customerMetadata = { userId, email, ...metadata };
    let customer;

    // 🧠 1️⃣ Buscar cliente existente por email
    const existingCustomers = await stripe.customers.list({
      email,
      limit: 1,
    });

    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
      console.log(`👤 Cliente existente encontrado: ${customer.email}`);
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: customerMetadata,
      });
      console.log(`🆕 Cliente nuevo creado: ${customer.id}`);
    }

    // 2️⃣ Crear clave efímera (para mobile)
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: MOBILE_STRIPE_API_VERSION }
    );

    // 3️⃣ Crear suscripción
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: subscriptionPriceId }],
      payment_behavior: "default_incomplete",
      collection_method: "charge_automatically",
      metadata: { userId, ...metadata },
    });

    const invoiceId =
      typeof subscription.latest_invoice === "string"
        ? subscription.latest_invoice
        : subscription.latest_invoice?.id;

    // 4️⃣ Verificar estado del invoice antes de finalizarlo
    let invoice = await stripe.invoices.retrieve(invoiceId);
    console.log(`🧾 Estado inicial del invoice: ${invoice.status}`);

    if (invoice.status === "draft") {
      console.log("🔧 Invoice en borrador — finalizando...");
      invoice = await stripe.invoices.finalizeInvoice(invoiceId);
    } else {
      console.log(`📄 Invoice ya está en estado: ${invoice.status}`);
    }

    // 5️⃣ Expandir el payment_intent para obtener el client_secret
    invoice = await stripe.invoices.retrieve(invoiceId, {
      expand: ["payment_intent"],
    });

    const paymentIntent = invoice.payment_intent;

    if (!paymentIntent || !paymentIntent.client_secret) {
      throw new Error("❌ No se pudo obtener el PaymentIntent desde la suscripción.");
    }

    console.log(`💳 Suscripción creada: ${subscription.id}`);
    console.log(`💳 PaymentIntent: ${paymentIntent.id} - Amount: ${paymentIntent.amount}`);
    console.log(`🔑 Client Secret obtenido exitosamente`);

    // 6️⃣ Responder al cliente móvil con el client secret de la suscripción
    res.json({
      clientSecret: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customer.id,
      subscriptionId: subscription.id,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error("Error creating payment sheet session:", err);
    res.status(500).json({
      error: "Failed to create payment sheet session",
      message: err.message,
    });
  }
};
