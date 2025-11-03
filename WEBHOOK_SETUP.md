# Configuración de Webhooks de Stripe

## Problema Resuelto
El `end_date` de las suscripciones ahora se actualiza automáticamente cuando:
- Se procesa un pago exitoso (`invoice.payment_succeeded`)
- La suscripción se actualiza en Stripe (`customer.subscription.updated`)

## Webhooks Necesarios

Para que el sistema funcione correctamente, necesitas configurar los siguientes eventos de webhook en Stripe:

### Eventos Críticos para Actualización de end_date:
1. **`customer.subscription.updated`** - Se dispara cuando cambia el período de facturación
2. **`invoice.payment_succeeded`** - Se dispara cuando un pago es exitoso (actualiza end_date)

### Otros Eventos Importantes:
3. **`customer.subscription.created`** - Nueva suscripción creada
4. **`customer.subscription.deleted`** - Suscripción cancelada
5. **`invoice.payment_failed`** - Pago fallido
6. **`checkout.session.completed`** - Checkout completado (opcional si usas Checkout)

## Configuración en Stripe Dashboard

### 1. Ir a Webhooks
1. Inicia sesión en [Stripe Dashboard](https://dashboard.stripe.com)
2. Ve a **Developers** → **Webhooks**
3. Click en **Add endpoint**

### 2. Configurar el Endpoint
- **Endpoint URL**: `https://tu-dominio.com/webhook` (o tu URL de producción)
- **Description**: "Subscription Updates"
- **Events to send**: Selecciona los eventos mencionados arriba

### 3. Obtener el Signing Secret
Después de crear el webhook:
1. Click en el webhook recién creado
2. En la sección **Signing secret**, click en **Reveal**
3. Copia el valor (comienza con `whsec_...`)
4. Actualiza tu `.env`:
   ```env
   STRIPE_WEBHOOK_SECRET=whsec_tu_secret_aqui
   ```

## Desarrollo Local con Stripe CLI

Para probar webhooks en desarrollo:

```powershell
# Instalar Stripe CLI (si no lo tienes)
# Descarga desde: https://stripe.com/docs/stripe-cli

# Login
stripe login

# Escuchar webhooks y reenviarlos a tu servidor local
stripe listen --forward-to localhost:3000/webhook

# Copiar el signing secret que aparece (whsec_...)
# y actualizar tu .env local
```

## Verificar que los Webhooks Funcionan

### 1. Revisar Logs del Servidor
Cuando un webhook se recibe, deberías ver logs como:
```
📥 Received event: customer.subscription.updated
🔄 Suscripción actualizada: sub_xxxxx
   - Status: active
   - current_period_start: 2025-11-03T...
   - current_period_end: 2025-12-03T...
✅ Subscription updated in Supabase via webhook (end_date actualizado)
```

### 2. Verificar en Stripe Dashboard
1. Ve a **Developers** → **Webhooks**
2. Click en tu webhook
3. Ve a la pestaña **Attempts**
4. Verifica que los eventos se envíen correctamente (status 200)

### 3. Probar Manualmente
Puedes disparar eventos de prueba desde:
- Stripe CLI: `stripe trigger customer.subscription.updated`
- Stripe Dashboard: En la página de webhooks, click en "Send test webhook"

## Endpoint de Sincronización Manual

Si los webhooks fallan o necesitas forzar una actualización:

```bash
# Sincronizar todas las suscripciones activas
POST http://tu-servidor.com/sync-subscriptions

# Respuesta:
{
  "message": "Sincronización completada",
  "updated": 5,
  "errors": 0,
  "total": 5
}
```

Este endpoint:
- Lee todas las suscripciones activas de Supabase
- Consulta sus datos actuales en Stripe
- Actualiza el `end_date` si es diferente
- Es útil como fallback si los webhooks fallan

## Flujo de Renovación Automática

Cuando una suscripción con facturación automática llega a su `end_date`:

1. **Stripe procesa el pago automáticamente**
2. **Se dispara `invoice.payment_succeeded`**
   - Tu servidor recibe el webhook
   - Registra el pago en la tabla `payments`
   - Obtiene la suscripción actualizada de Stripe
   - Actualiza `end_date` con el nuevo `current_period_end`
3. **Se dispara `customer.subscription.updated`**
   - Tu servidor recibe el webhook
   - Actualiza `end_date` y `status` en Supabase

## Troubleshooting

### El end_date no se actualiza
✅ **Verifica**:
1. Los webhooks están configurados en Stripe Dashboard
2. El `STRIPE_WEBHOOK_SECRET` es correcto en `.env`
3. Los logs del servidor muestran eventos recibidos
4. La tabla `subscriptions` tiene permisos de escritura

### Webhooks devuelven error 400
✅ **Causa**: Signing secret incorrecto
✅ **Solución**: Verifica que `STRIPE_WEBHOOK_SECRET` coincida con el de Stripe

### Los webhooks no llegan en desarrollo
✅ **Solución**: Usa Stripe CLI con `stripe listen --forward-to`

### Necesitas actualizar end_date inmediatamente
✅ **Solución**: Llama al endpoint `/sync-subscriptions`

## Logs Mejorados

Ahora los webhooks incluyen logs detallados:

```
✅ Pago exitoso para suscripción sub_xxxxx
📅 Invoice period: 1730678400 - 1733356800
🔄 Actualizando end_date de suscripción sub_xxxxx
   - current_period_start: 2025-11-03T12:00:00.000Z
   - current_period_end: 2025-12-03T12:00:00.000Z
✅ Payment recorded in Supabase via webhook
✅ Subscription dates updated in Supabase after payment
```

Estos logs te ayudarán a verificar que el `end_date` se actualiza correctamente.
