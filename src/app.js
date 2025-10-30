import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import paymentRoutes from './routes/payment.js';
import { handleWebhook } from './controllers/stripeController.js';

dotenv.config();
const app = express();

// Middlewares
app.use(cors());

app.post('/api/payments/webhook', 
    express.raw({ type: 'application/json' }),
    handleWebhook
);

// Para el resto de rutas, usar JSON
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'stripe-payment' });
});

// Rutas
app.use('/api/payments', paymentRoutes);

// Manejo de errores global
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Puerto
const PORT = process.env.PORT || 8001;
app.listen(PORT, () => {
    console.log(`🚀 Stripe service running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
});
