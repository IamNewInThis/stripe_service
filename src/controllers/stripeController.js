import Stripe from 'stripe';
import dotenv from 'dotenv';
import { upsertSubscription, recordPayment } from '../services/subscriptionService.js';
dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const priceId = process.env.STRIPE_DEFAULT_PRICE_ID;
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

const buildCustomerMetadata = (userId, userName, metadata = {}) => ({
  ...(userId ? { userId } : {}),
  ...(userName ? { userName: String(userName) } : {}),
  ...metadata,
});

const extractInvoiceId = (invoice) => {
  if (!invoice) return null;
  if (typeof invoice === 'string') return invoice;
  if (invoice.id) return invoice.id;
  return null;
};

const ensureCustomerMetadata = async (customer, { email, userId, userName }) => {
  const needsUpdate =
    (email && customer.email !== email) ||
    (userId && customer.metadata?.userId !== userId) ||
    (userName && customer.metadata?.userName !== String(userName));

  if (needsUpdate) {
    await stripe.customers.update(customer.id, {
      ...(email ? { email } : {}),
      metadata: {
        ...(customer.metadata || {}),
        ...(userId ? { userId } : {}),
        ...(userName ? { userName: String(userName) } : {}),
      },
    });
  }

  return stripe.customers.retrieve(customer.id);
};

const findOrCreateCustomer = async ({ userId, email, userName }) => {
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
      name: userName,
      metadata: buildCustomerMetadata(userId),
    });
  } else {
    customer = await ensureCustomerMetadata(customer, { email, userId, userName });
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
      break;

    case 'customer.subscription.created':
      const subscription = event.data.object;
      console.log(`📝 Suscripción creada: ${subscription.id}`);

      // Guardar suscripción en Supabase
      try {
        // Intentar obtener userId del metadata del customer
        let userId = null;
        if (subscription.customer) {
          try {
            const customer = await stripe.customers.retrieve(subscription.customer);
            userId = customer.metadata?.userId;
          } catch (customerError) {
            console.error('⚠️  Error retrieving customer:', customerError);
          }
        }

        await upsertSubscription(subscription, userId);
        console.log('✅ Subscription saved to Supabase via webhook');
      } catch (supabaseError) {
        console.error('❌ Failed to save subscription to Supabase:', supabaseError);
      }
      break;

    case 'customer.subscription.updated':
      const updatedSubscription = event.data.object;
      console.log(`🔄 Suscripción actualizada: ${updatedSubscription.id}`);

      // Actualizar suscripción en Supabase
      try {
        await upsertSubscription(updatedSubscription);
        console.log('✅ Subscription updated in Supabase via webhook');
      } catch (supabaseError) {
        console.error('❌ Failed to update subscription in Supabase:', supabaseError);
      }
      break;

    case 'customer.subscription.deleted':
      const deletedSubscription = event.data.object;
      console.log(`❌ Suscripción cancelada: ${deletedSubscription.id}`);

      // Actualizar estado en Supabase
      try {
        await upsertSubscription(deletedSubscription);
        console.log('✅ Subscription marked as deleted in Supabase via webhook');
      } catch (supabaseError) {
        console.error('❌ Failed to update subscription status in Supabase:', supabaseError);
      }
      break;

    case 'invoice.payment_succeeded':
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription;
      console.log(`✅ Pago exitoso para suscripción ${subscriptionId}`);

      // Registrar el pago en Supabase
      try {
        await recordPayment(invoice);
        console.log('✅ Payment recorded in Supabase via webhook');

        // También actualizar la suscripción a 'active' si existe
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await upsertSubscription(subscription);
          console.log('✅ Subscription status updated to active in Supabase');
        }
      } catch (supabaseError) {
        console.error('❌ Failed to record payment in Supabase:', supabaseError);
      }
      break;

    case 'invoice.payment_failed':
      const failedInvoice = event.data.object;
      console.log(`⚠️  Pago fallido para factura: ${failedInvoice.id}`);

      // Registrar el pago fallido
      try {
        await recordPayment(failedInvoice);
        console.log('✅ Failed payment recorded in Supabase via webhook');
      } catch (supabaseError) {
        console.error('❌ Failed to record failed payment in Supabase:', supabaseError);
      }
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

export const getSubscriptionStatusByUserId = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    // 🔍 Buscar cliente por metadata['userId']
    const customers = await stripe.customers.search({
      query: `metadata['userId']:'${userId}'`,
    });

    if (customers.data.length === 0) {
      return res.status(404).json({
        error: "Customer not found for this userId",
      });
    }

    const customer = customers.data[0];

    // 🔄 Buscar suscripciones del cliente
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      return res.json({
        hasSubscription: false,
        message: "No active subscription found",
      });
    }

    const subscription = subscriptions.data[0];

    return res.json({
      subscriptionId: subscription.id,
      hasSubscription: true,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      subscription: subscription,
      stripeCustomerId: customer.id,
    });
  } catch (err) {
    console.error("❌ Error getting subscription status by userId:", err);
    return res.status(500).json({
      error: "Failed to get subscription status",
      message: err.message,
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
    const { planId, priceId: priceIdOverride, userId, email, userName, metadata = {} } = req.body;


    let priceId;
    try {
      priceId = resolvePriceId(planId, priceIdOverride);
    } catch (resolveError) {
      return res.status(400).json({ error: resolveError.message });
    }

    const customer = await findOrCreateCustomer({ userId, email, userName });
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

    // 🆕 Guardar la suscripción en Supabase
    try {
      await upsertSubscription(subscription, userId);
      console.log('✅ Subscription saved to Supabase');
    } catch (supabaseError) {
      console.error('⚠️  Failed to save subscription to Supabase:', supabaseError);
      // No lanzamos el error para no interrumpir el flujo de Stripe
    }

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

export const createCard = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    // 1️⃣ Buscar el Customer de Stripe asociado a este usuario
    const customers = await stripe.customers.search({
      query: `metadata['userId']:'${userId}'`,
    });

    if (customers.data.length === 0) {
      return res.status(404).json({
        error: "Customer not found for this userId",
      });
    }

    const customer = customers.data[0]; // tomamos el primer resultado

    // 2️⃣ Crear un SetupIntent para que el usuario guarde una nueva tarjeta
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ["card"],
    });

    // 3️⃣ Crear un Ephemeral Key (clave temporal) para el cliente
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: "2024-06-20" }
    );

    // 4️⃣ Enviar al frontend los datos que necesita el PaymentSheet
    return res.status(200).json({
      setupIntentClientSecret: setupIntent.client_secret,
      ephemeralKeySecret: ephemeralKey.secret,
      customer: customer.id,
      publishableKey: process.env.STRIPE_PUBLIC_KEY,
    });
  } catch (error) {
    console.error("❌ Error creating SetupIntent:", error);
    return res.status(500).json({
      error: "Failed to create SetupIntent",
      message: error.message,
    });
  }
};

export const listCardsForUser = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    // Buscar customer por metadata['userId']
    const customers = await stripe.customers.search({
      query: `metadata['userId']:'${userId}'`,
    });

    if (!customers || customers.data.length === 0) {
      return res.status(404).json({ error: "Customer not found for this userId" });
    }

    const customer = customers.data[0];

    // Obtener los métodos de pago tipo card asociados al customer
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customer.id,
      type: "card",
    });

    const customerInfo = await stripe.customers.retrieve(customer.id);
    const defaultPaymentMethodId = customerInfo.invoice_settings?.default_payment_method;


    // Mapear a lo que el frontend necesita (últimos 4, brand, exp_month, exp_year, id)
    const cards = paymentMethods.data.map(pm => ({
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      exp_month: pm.card.exp_month,
      exp_year: pm.card.exp_year,
      isDefault: pm.id === defaultPaymentMethodId, // 👈 true solo si coincide con el default
    }));

    return res.status(200).json({ customer: customer.id, cards });
  } catch (err) {
    console.error("Error listing cards:", err);
    return res.status(500).json({ error: "Failed to list cards", message: err.message });
  }
};

export const setDefaultCard = async (req, res) => {
  try {
    const { userId } = req.params;
    const { cardId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    // Buscar customer por metadata['userId']
    const customers = await stripe.customers.search({
      query: `metadata['userId']:'${userId}'`,
    });

    if (!customers || customers.data.length === 0) {
      return res.status(404).json({ error: "Customer not found for this userId" });
    }

    const customer = customers.data[0];

    // ✅ Actualizar la tarjeta predeterminada del cliente en Stripe
    const paymentMethods = await stripe.customers.update(customer.id, {
      invoice_settings: {
        default_payment_method: cardId,
      },
    });

    console.log(`✅ Tarjeta ${cardId} establecida como predeterminada para el usuario ${userId}`);

    return res.status(200).json({
      message: "Tarjeta establecida como predeterminada correctamente.",
      paymentMethods,
    });
  } catch (error) {
    console.error("❌ Error al establecer tarjeta por defecto:", error);
    return res.status(500).json({
      error: error.message || "Error al establecer tarjeta por defecto.",
    });
  }
};

export const deleteCard = async (req, res) => {
  console.log("🧾 DELETE CARD - Params:", req.params);
  console.log("🧾 DELETE CARD - Body:", req.body);
  try {
    const { userId } = req.params;
    const { cardId } = req.body;

    if (!userId || !cardId) {
      return res
        .status(400)
        .json({ error: "Faltan parámetros: userId o cardId." });
    }

    // 🔍 Buscar el customer en Stripe por metadata['userId']
    const customers = await stripe.customers.search({
      query: `metadata['userId']:'${userId}'`,
    });

    if (!customers || customers.data.length === 0) {
      return res
        .status(404)
        .json({ error: "Customer no encontrado para este userId." });
    }

    const customer = customers.data[0];
    const currentDefault = customer.invoice_settings?.default_payment_method;

    // 🔥 Eliminar la tarjeta
    await stripe.paymentMethods.detach(cardId);
    console.log(`🗑️ Tarjeta ${cardId} eliminada correctamente.`);

    // 🧩 Buscar tarjetas restantes
    const remainingCards = await stripe.paymentMethods.list({
      customer: customer.id,
      type: "card",
    });

    if (remainingCards.data.length > 0) {
      // ✅ Asignar nueva tarjeta predeterminada (por ejemplo, la primera)
      const newDefault = remainingCards.data[0].id;
      await stripe.customers.update(customer.id, {
        invoice_settings: {
          default_payment_method: newDefault,
        },
      });

      console.log(`✅ Nueva tarjeta predeterminada: ${newDefault}`);

      return res.status(200).json({
        message: "Tarjeta eliminada y nueva predeterminada asignada.",
        removedCardId: cardId,
        newDefaultCardId: newDefault,
      });
    }

    // ⚠️ Si no hay más tarjetas, simplemente dejar sin default
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: null },
    });

    console.log("⚠️ Cliente quedó sin tarjeta predeterminada.");

    return res.status(200).json({
      message:
        "Tarjeta eliminada. El cliente quedó sin tarjeta predeterminada.",
      removedCardId: cardId,
    });
  } catch (error) {
    console.error("❌ Error al eliminar tarjeta:", error);
    return res.status(500).json({
      error: error.message || "Error al eliminar tarjeta.",
    });
  }
};