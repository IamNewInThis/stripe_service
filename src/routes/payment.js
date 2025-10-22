import express from 'express';
import { 
    handleWebhook,
    getSubscriptionStatus,
    cancelSubscription,
    createSubscriptionSession,
    getSubscriptionStatusByUserId,
    createSubscription,
    createCard,
    listCardsForUser,
    setDefaultCard
} from '../controllers/stripeController.js';

const router = express.Router();

// Crear sesión para SetupIntent + PaymentSheet (suscripciones nativas)
router.post('/create-subscription-session', createSubscriptionSession);

// Crear suscripción y obtener PaymentIntent inicial
router.post('/create-subscription', createSubscription);

// Crear sesión de pago (para checkout web)

// Webhook (para recibir eventos de Stripe)
// IMPORTANTE: Esta ruta debe usar express.raw() configurado en app.js
router.post('/webhook', handleWebhook);

// Obtener estado de suscripción en base al customerId de Stripe
router.get('/subscription/:customerId', getSubscriptionStatus);

//obtener estado de suscripción en base al id de supabase
router.get("/subscription/user/:userId", getSubscriptionStatusByUserId);

// Cancelar suscripción
router.post('/subscription/cancel/:subscriptionId', cancelSubscription);

// Añadir tarjetas de crédito
router.post('/create-card/:userId', createCard);

//Listar tarjetas del cliente
router.get('/cards/:userId', listCardsForUser);

router.post('/cards/default/:userId', setDefaultCard);

export default router;
