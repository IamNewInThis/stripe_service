import express from 'express';
import { 
    createCheckoutSession, 
    handleWebhook,
    getSubscriptionStatus,
    cancelSubscription,
    createPaymentSheetSession
} from '../controllers/stripeController.js';

const router = express.Router();

// Crear Payment Sheet (para pagos nativos con Google Pay/Apple Pay)
router.post('/create-payment-sheet', createPaymentSheetSession);

// Crear sesión de pago (para checkout web)
router.post('/create-session', createCheckoutSession);

// Webhook (para recibir eventos de Stripe)
// IMPORTANTE: Esta ruta debe usar express.raw() configurado en app.js
router.post('/webhook', handleWebhook);

// Obtener estado de suscripción
router.get('/subscription/:customerId', getSubscriptionStatus);

// Cancelar suscripción
router.post('/subscription/:subscriptionId/cancel', cancelSubscription);

export default router;
