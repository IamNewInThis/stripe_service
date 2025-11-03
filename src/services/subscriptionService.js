import supabase from '../config/supabase.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function getUserIdFromStripeCustomer(stripeCustomerId) {
    try {
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        return customer.metadata?.userId || customer.metadata?.supabase_user_id || null;
    } catch (error) {
        console.error('Error retrieving customer from Stripe:', error);
        return null;
    }
}

/**
 * Encuentra el user_id de Supabase usando el stripe_customer_id
 */
export async function findUserByStripeCustomerId(stripeCustomerId) {
    try {
        const { data, error } = await supabase
            .from('subscriptions')
            .select('user_id')
            .eq('stripe_customer_id', stripeCustomerId)
            .limit(1)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            console.error('Error finding user by stripe customer id:', error);
            return null;
        }

        return data?.user_id || null;
    } catch (error) {
        console.error('findUserByStripeCustomerId error:', error);
        return null;
    }
}

/**
 * Crea o actualiza una suscripción en Supabase desde Stripe
 * ✅ VERSIÓN MEJORADA: Siempre obtiene datos completos desde Stripe API
 */
export async function upsertSubscription(stripeSubscription, userId = null) {
    try {
        console.log('📝 Upserting subscription to Supabase:', {
            stripe_subscription_id: stripeSubscription.id,
            stripe_customer_id: stripeSubscription.customer,
            status: stripeSubscription.status
        });

        // 🔄 Obtener la suscripción completa desde Stripe API
        let fullSubscription;
        try {
            console.log('🔄 Obteniendo datos completos desde Stripe API...');
            fullSubscription = await stripe.subscriptions.retrieve(stripeSubscription.id);
            console.log('✅ Suscripción completa obtenida');
            console.log('📅 Status:', fullSubscription.status);
            console.log('📅 current_period_start:', fullSubscription.current_period_start);
            console.log('📅 current_period_end:', fullSubscription.current_period_end);
        } catch (retrieveError) {
            console.error('⚠️ Error retrieving subscription:', retrieveError);
            fullSubscription = stripeSubscription;
        }

        // Obtener userId
        if (!userId) {
            userId = await getUserIdFromStripeCustomer(fullSubscription.customer);
            if (!userId) {
                userId = await findUserByStripeCustomerId(fullSubscription.customer);
            }
        }

        if (!userId) {
            console.error('❌ Cannot upsert subscription: user_id not found');
            return null;
        }

        // Determinar el plan
        const priceItem = fullSubscription.items?.data?.[0];
        let planName = 'monthly';

        if (priceItem?.price?.nickname) {
            planName = priceItem.price.nickname;
        } else if (priceItem?.price?.recurring?.interval) {
            planName = priceItem.price.recurring.interval;
        }

        // Calcular fechas
        const startDate = fullSubscription.current_period_start
            ? new Date(fullSubscription.current_period_start * 1000)
            : fullSubscription.start_date 
            ? new Date(fullSubscription.start_date * 1000)
            : new Date(fullSubscription.created * 1000);

        let endDate = null;

        // Intentar obtener end_date de múltiples fuentes
        if (fullSubscription.current_period_end) {
            endDate = new Date(fullSubscription.current_period_end * 1000);
        } else if (fullSubscription.trial_end) {
            endDate = new Date(fullSubscription.trial_end * 1000);
        } else if (fullSubscription.billing_cycle_anchor && priceItem?.price?.recurring) {
            const interval = priceItem.price.recurring.interval;
            const intervalCount = priceItem.price.recurring.interval_count || 1;
            
            endDate = new Date(fullSubscription.billing_cycle_anchor * 1000);
            
            if (interval === 'month') {
                endDate.setMonth(endDate.getMonth() + intervalCount);
            } else if (interval === 'year') {
                endDate.setFullYear(endDate.getFullYear() + intervalCount);
            } else if (interval === 'week') {
                endDate.setDate(endDate.getDate() + (7 * intervalCount));
            } else if (interval === 'day') {
                endDate.setDate(endDate.getDate() + intervalCount);
            }
        } else {
            // Fallback final
            const interval = priceItem?.price?.recurring?.interval || 'month';
            const intervalCount = priceItem?.price?.recurring?.interval_count || 1;

            endDate = new Date(startDate);

            if (interval === 'month') {
                endDate.setMonth(endDate.getMonth() + intervalCount);
            } else if (interval === 'year') {
                endDate.setFullYear(endDate.getFullYear() + intervalCount);
            } else if (interval === 'week') {
                endDate.setDate(endDate.getDate() + (7 * intervalCount));
            } else if (interval === 'day') {
                endDate.setDate(endDate.getDate() + intervalCount);
            }
        }

        const subscriptionData = {
            user_id: userId,
            stripe_customer_id: fullSubscription.customer,
            stripe_subscription_id: fullSubscription.id,
            status: fullSubscription.status,
            plan_name: planName,
            start_date: startDate,
            end_date: endDate,
            canceled_date: fullSubscription.canceled_at 
                ? new Date(fullSubscription.canceled_at * 1000)
                : null
        };

        console.log('📦 Datos a guardar:', {
            ...subscriptionData,
            start_date: subscriptionData.start_date.toISOString(),
            end_date: subscriptionData.end_date?.toISOString(),
            canceled_date: subscriptionData.canceled_date?.toISOString() || 'null',
        });

        // Buscar si ya existe
        const { data: existingSubscription, error: existingStripeError } = await supabase
            .from('subscriptions')
            .select('id, status')
            .eq('stripe_subscription_id', fullSubscription.id)
            .maybeSingle();

        if (existingStripeError && existingStripeError.code !== 'PGRST116') {
            console.error('⚠️  Error finding subscription:', existingStripeError);
        } else if (existingSubscription) {
            console.log('📝 Actualizando suscripción existente');
            subscriptionData.id = existingSubscription.id;
        } else {
            console.log('🆕 Creando nueva suscripción');
        }

        // Guardar
        const { data, error } = await supabase
            .from('subscriptions')
            .upsert(subscriptionData, {
                onConflict: 'stripe_subscription_id',
                ignoreDuplicates: false
            })
            .select()
            .single();

        if (error) {
            console.error('❌ Error upserting subscription:', error);
            throw error;
        }

        console.log('✅ Subscription upserted:', {
            id: data.id,
            status: data.status,
            end_date: data.end_date
        });

        // ❌ ELIMINADO: Ya NO marca otras suscripciones como canceladas automáticamente
        // Esto solo debe ocurrir cuando Stripe envíe el evento de cancelación

        return data;
    } catch (error) {
        console.error('upsertSubscription error:', error);
        throw error;
    }
}

/**
 * Cancela una suscripción en Supabase cuando se cancela en Stripe
 */
export async function cancelSubscriptionSB(stripeSubscriptionId, userId) {
    try {
        console.log('❌ Cancelando suscripción:', stripeSubscriptionId);

        // Obtener datos completos desde Stripe
        let fullSubscription;
        try {
            fullSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
            console.log('✅ Suscripción obtenida desde Stripe');
            console.log('📅 Status:', fullSubscription.status);
            console.log('📅 canceled_at:', fullSubscription.canceled_at);
            console.log('📅 current_period_end:', fullSubscription.current_period_end);
        } catch (retrieveError) {
            console.error('⚠️ Error retrieving subscription:', retrieveError);
            return null;
        }

        // Obtener userId si no se proporcionó
        if (!userId) {
            userId = await getUserIdFromStripeCustomer(fullSubscription.customer);

            if (!userId) {
                userId = await findUserByStripeCustomerId(fullSubscription.customer);
            }
        }

        if (!userId) {
            console.error('❌ Cannot cancel subscription: user_id not found');
            return null;
        }

        // Calcular fechas de cancelación
        const canceledDate = fullSubscription.canceled_at 
            ? new Date(fullSubscription.canceled_at * 1000)
            : new Date();

        // end_date: mantener current_period_end si existe (acceso hasta fin de periodo)
        // o usar canceled_date si es cancelación inmediata
        const endDate = fullSubscription.current_period_end
            ? new Date(fullSubscription.current_period_end * 1000)
            : canceledDate;

        console.log('📅 Fechas de cancelación:');
        console.log('  - canceled_date:', canceledDate.toISOString());
        console.log('  - end_date:', endDate.toISOString());

        // Actualizar en Supabase
        const { data, error } = await supabase
            .from('subscriptions')
            .update({
                status: 'canceled',
                canceled_date: canceledDate,
                end_date: endDate
            })
            .eq('stripe_subscription_id', stripeSubscriptionId)
            .select()
            .single();

        if (error) {
            console.error('❌ Error canceling subscription in Supabase:', error);
            throw error;
        }

        if (!data) {
            console.warn('⚠️ No subscription found with stripe_subscription_id:', stripeSubscriptionId);
            return null;
        }

        console.log('✅ Subscription canceled successfully:', {
            id: data.id,
            user_id: data.user_id,
            status: data.status,
            canceled_date: data.canceled_date,
            end_date: data.end_date
        });

        return data;
    } catch (error) {
        console.error('cancelSubscription error:', error);
        throw error;
    }
}

/**
 * Registra un pago en Supabase desde un invoice de Stripe
 * ✅ PERMITE DUPLICADOS: Cada pago es un registro independiente
 */
export async function recordPayment(stripeInvoice, subscriptionId = null) {
    try {
        console.log('💳 Recording payment in Supabase:', {
            invoice_id: stripeInvoice.id,
            subscription_id: subscriptionId,
            payment_intent: stripeInvoice.payment_intent,
            customer: stripeInvoice.customer,
            amount: stripeInvoice.amount_paid / 100,
            status: stripeInvoice.status
        });

        // Buscar user_id
        let userId = await getUserIdFromStripeCustomer(stripeInvoice.customer);

        if (!userId) {
            userId = await findUserByStripeCustomerId(stripeInvoice.customer);
        }

        if (!userId) {
            console.error('❌ Cannot record payment: user_id not found for customer:', stripeInvoice.customer);
            return null;
        }

        // Determinar estado del pago
        let paymentStatus = 'pending';
        if (stripeInvoice.status === 'paid') {
            paymentStatus = 'completed';
        } else if (stripeInvoice.status === 'open') {
            paymentStatus = 'pending';
        } else if (['uncollectible', 'void'].includes(stripeInvoice.status)) {
            paymentStatus = 'failed';
        }

        const paymentData = {
            user_id: userId,
            subscription_id: subscriptionId,
            amount: stripeInvoice.amount_paid / 100,
            stripe_payment_id: stripeInvoice.payment_intent || stripeInvoice.id,
            payment_status: paymentStatus,
            transaction_date: new Date(stripeInvoice.created * 1000)
        };

        console.log('💾 Inserting payment:', paymentData);

        // ✅ SIEMPRE insertar (permite duplicados)
        const { data, error } = await supabase
            .from('payments')
            .insert(paymentData)
            .select()
            .single();

        if (error) {
            console.error('❌ Error recording payment:', error);
            throw error;
        }

        console.log('✅ Payment recorded:', {
            id: data.id,
            amount: data.amount,
            status: data.payment_status
        });

        return data;
    } catch (error) {
        console.error('recordPayment error:', error);
        throw error;
    }
}

/**
 * Obtiene o crea un customer de Stripe para un usuario
 */
export async function getOrCreateStripeCustomer(userId, email) {
    try {
        // Buscar si ya tiene customer
        const { data: subscription } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('user_id', userId)
            .not('stripe_customer_id', 'is', null)
            .limit(1)
            .maybeSingle();

        if (subscription?.stripe_customer_id) {
            console.log('✅ Found existing Stripe customer:', subscription.stripe_customer_id);
            return subscription.stripe_customer_id;
        }

        // Crear nuevo customer
        console.log('🆕 Creating new Stripe customer for user:', userId);
        const customer = await stripe.customers.create({
            email,
            metadata: {
                userId: userId,
                supabase_user_id: userId
            }
        });

        console.log('✅ Created Stripe customer:', customer.id);
        return customer.id;
    } catch (error) {
        console.error('getOrCreateStripeCustomer error:', error);
        throw error;
    }
}

/**
 * Sincroniza suscripciones activas desde Stripe (útil para catch-up si webhooks fallan)
 * Actualiza end_date y status basándose en datos de Stripe
 */
export async function syncActiveSubscriptions() {
    try {
        console.log('🔄 Sincronizando suscripciones activas desde Stripe...');

        // Obtener todas las suscripciones activas o pasadas de Supabase
        const { data: subscriptions, error } = await supabase
            .from('subscriptions')
            .select('stripe_subscription_id, user_id, status, end_date')
            .in('status', ['active', 'trialing', 'past_due']);

        if (error) {
            console.error('❌ Error obteniendo suscripciones de Supabase:', error);
            return;
        }

        if (!subscriptions || subscriptions.length === 0) {
            console.log('ℹ️ No hay suscripciones activas para sincronizar');
            return;
        }

        console.log(`📊 Sincronizando ${subscriptions.length} suscripciones...`);

        let updated = 0;
        let errors = 0;

        for (const sub of subscriptions) {
            try {
                // Obtener datos actuales desde Stripe
                const stripeSubscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
                
                const currentEndDate = sub.end_date ? new Date(sub.end_date) : null;
                const stripeEndDate = new Date(stripeSubscription.current_period_end * 1000);

                // Verificar si el end_date necesita actualizarse
                const needsUpdate = 
                    !currentEndDate || 
                    currentEndDate.getTime() !== stripeEndDate.getTime() ||
                    sub.status !== stripeSubscription.status;

                if (needsUpdate) {
                    console.log(`🔄 Actualizando suscripción ${sub.stripe_subscription_id}`);
                    console.log(`   - End date actual: ${currentEndDate?.toISOString() || 'null'}`);
                    console.log(`   - End date Stripe: ${stripeEndDate.toISOString()}`);
                    console.log(`   - Status actual: ${sub.status}`);
                    console.log(`   - Status Stripe: ${stripeSubscription.status}`);
                    
                    await upsertSubscription(stripeSubscription, sub.user_id);
                    updated++;
                }
            } catch (subError) {
                console.error(`❌ Error sincronizando suscripción ${sub.stripe_subscription_id}:`, subError);
                errors++;
            }
        }

        console.log(`✅ Sincronización completada: ${updated} actualizadas, ${errors} errores`);
        return { updated, errors, total: subscriptions.length };
    } catch (error) {
        console.error('syncActiveSubscriptions error:', error);
        throw error;
    }
}