import express from 'express';
import { 
    handleWebhook,
    getSubscriptionStatus,
    cancelSubscription,
    createSubscriptionSession,
    createSubscription
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

// Obtener estado de suscripción
router.get('/subscription/:customerId', getSubscriptionStatus);

// Cancelar suscripción
router.post('/subscription/:subscriptionId/cancel', cancelSubscription);

export default router;
