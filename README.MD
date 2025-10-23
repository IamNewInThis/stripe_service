# 💳 Stripe Payment Service - Lumi App

Servicio de pagos con Stripe para la aplicación móvil Lumi. Este microservicio maneja suscripciones, pagos y webhooks de Stripe.

## 📋 Requisitos Previos

- Node.js 18+ instalado
- Cuenta de Stripe (https://dashboard.stripe.com)
- Docker (opcional, para contenedorización)

## 🚀 Configuración Inicial

### 1. Instalar dependencias

```bash
cd stripe_service
npm install
```

### 2. Configurar variables de entorno

Copia el archivo `.env.example` a `.env` y configura tus claves:

```bash
cp .env.example .env
```

Edita el archivo `.env` con tus credenciales:

```env
PORT=8001
STRIPE_SECRET_KEY=sk_test_tu_clave_secreta
STRIPE_WEBHOOK_SECRET=whsec_tu_webhook_secret
CLIENT_URL=https://tuapp.expo.dev
NODE_ENV=development
```

### 3. Obtener claves de Stripe

#### Clave Secreta (STRIPE_SECRET_KEY)
1. Ve a https://dashboard.stripe.com/apikeys
2. Copia la "Secret key" (comienza con `sk_test_` para testing)

#### Webhook Secret (STRIPE_WEBHOOK_SECRET)
1. Ve a https://dashboard.stripe.com/webhooks
2. Crea un nuevo endpoint webhook
3. URL: `https://tu-servidor.com/api/payments/webhook`
4. Selecciona estos eventos:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
5. Copia el "Signing secret" (comienza con `whsec_`)

### 4. Crear Productos y Precios en Stripe

1. Ve a https://dashboard.stripe.com/products
2. Crea un producto (ej: "Lumi Premium")
3. Añade un precio recurrente (ej: $9.99/mes)
4. Copia el ID del precio (comienza con `price_`)

## 🏃‍♂️ Ejecutar el Servicio

### Modo desarrollo

```bash
npm run dev
```

### Modo producción

```bash
npm start
```

El servicio estará disponible en `http://localhost:8001`

## 🐳 Docker

### Construir imagen

```bash
docker build -t lumi-stripe-service .
```

### Ejecutar contenedor

```bash
docker run -p 8001:8001 --env-file .env lumi-stripe-service
```

## 📡 Endpoints API

### 1. Health Check
```http
GET /health
```

**Respuesta:**
```json
{
  "status": "ok",
  "service": "stripe-payment"
}
```

### 2. Crear Sesión de Checkout
```http
POST /api/payments/create-session
Content-Type: application/json

{
  "priceId": "price_1234567890",
  "userId": "user-uuid-123",
  "email": "usuario@email.com"
}
```

**Respuesta:**
```json
{
  "url": "https://checkout.stripe.com/c/pay/cs_test_...",
  "sessionId": "cs_test_1234567890"
}
```

### 3. Webhook (Stripe)
```http
POST /api/payments/webhook
Content-Type: application/json
Stripe-Signature: t=xxx,v1=yyy
```

Este endpoint recibe eventos de Stripe automáticamente.

### 4. Obtener Estado de Suscripción
```http
GET /api/payments/subscription/:customerId
```

**Respuesta:**
```json
{
  "hasSubscription": true,
  "status": "active",
  "currentPeriodEnd": 1234567890,
  "cancelAtPeriodEnd": false
}
```

### 5. Cancelar Suscripción
```http
POST /api/payments/subscription/:subscriptionId/cancel
```

**Respuesta:**
```json
{
  "message": "Subscription will be cancelled at period end",
  "subscription": { ... }
}
```

## 📱 Integración con App Móvil (React Native)

### 1. Instalar dependencias en la app

```bash
cd lumi_app
npm install @stripe/stripe-react-native axios
```

## 🔧 Testing Local con Stripe CLI

### 1. Instalar Stripe CLI

```bash
brew install stripe/stripe-cli/stripe
```

### 2. Login en Stripe

```bash
stripe login
```

### 3. Escuchar webhooks localmente

```bash
stripe listen --forward-to localhost:8001/api/payments/webhook
```

Copia el "webhook signing secret" que aparece y úsalo en tu `.env`

### 4. Probar eventos

```bash
stripe trigger checkout.session.completed
```

## 🔒 Seguridad

- ✅ Las claves secretas están en `.env` (no commitear al repo)
- ✅ Los webhooks verifican firma de Stripe
- ✅ Validación de parámetros en todos los endpoints
- ✅ CORS configurado para tu dominio

## 📊 Monitoreo

Ver logs en tiempo real:

```bash
# Logs del servicio
npm run dev

# Logs de webhooks en Stripe Dashboard
https://dashboard.stripe.com/webhooks
```

## 🐛 Troubleshooting

### Error: "No signatures found matching the expected signature"
- Verifica que `STRIPE_WEBHOOK_SECRET` esté correctamente configurado
- Asegúrate de usar `express.raw()` para la ruta del webhook

### Error: "Invalid API Key"
- Verifica que `STRIPE_SECRET_KEY` sea correcta
- Asegúrate de usar claves de test (`sk_test_`) en desarrollo

### Webhook no recibe eventos
- Verifica que la URL del webhook en Stripe Dashboard sea correcta
- Asegúrate de que tu servidor sea accesible públicamente (usa ngrok para testing local)

## 📚 Recursos

- [Stripe Documentation](https://stripe.com/docs)
- [Stripe React Native](https://stripe.com/docs/payments/accept-a-payment?platform=react-native)
- [Stripe Webhooks Guide](https://stripe.com/docs/webhooks)

## 🤝 TODO

- [ ] Subir a servidor de producción
- [ ] Añadir notificaciones push para eventos de pago
- [ ] Implementar retry logic para webhooks fallidos
- [ ] Añadir tests unitarios
- [ ] Configurar CI/CD

## 📝 License

ISC
