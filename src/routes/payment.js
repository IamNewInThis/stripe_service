import express from 'express';
import { 
    getSubscriptionStatus,
    cancelSubscription,
    createSubscriptionSession,
    getSubscriptionStatusByUserId,
    createSubscription,
    createCard,
    listCardsForUser,
    setDefaultCard,
    deleteCard
} from '../controllers/stripeController.js';

const router = express.Router();

// Crear sesión para SetupIntent + PaymentSheet (suscripciones nativas)
router.post('/create-subscription-session', createSubscriptionSession);

// Crear suscripción y obtener PaymentIntent inicial
router.post('/create-subscription', createSubscription);

// Crear sesión de pago (para checkout web)

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

//Establecer tarjeta por defecto
router.post('/cards/default/:userId', setDefaultCard);

//Eliminar tarjeta de credito
router.post('/cards/delete/:userId', deleteCard);

export default router;
