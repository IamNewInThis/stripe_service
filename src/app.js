import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import paymentRoutes from './routes/payment.js';

dotenv.config();
const app = express();

// Middlewares
app.use(cors());

// Webhook debe usar raw body antes de JSON parsing
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

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
