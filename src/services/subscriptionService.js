import supabase from '../config/supabase.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Obtiene el userId del metadata del customer en Stripe
 */
async function getUserIdFromStripeCustomer(stripeCustomerId) {
    try {
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        return customer.metadata?.userId || null;
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
            .single();

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
 */
export async function upsertSubscription(stripeSubscription, userId = null) {
    try {
        console.log('📝 Upserting subscription to Supabase:', {
            stripe_subscription_id: stripeSubscription.id,
            stripe_customer_id: stripeSubscription.customer,
            status: stripeSubscription.status
        });

        // Si no tenemos userId, intentamos encontrarlo de varias formas
        if (!userId) {
            // 1. Intentar desde metadata del customer en Stripe
            userId = await getUserIdFromStripeCustomer(stripeSubscription.customer);
            
            // 2. Si no, buscar en subscriptions existentes
            if (!userId) {
                userId = await findUserByStripeCustomerId(stripeSubscription.customer);
            }
        }

        if (!userId) {
            console.error('❌ Cannot upsert subscription: user_id not found for customer:', stripeSubscription.customer);
            return null;
        }

        // Determinar el plan basado en el price o nickname
        const priceItem = stripeSubscription.items?.data[0];
        let planName = 'monthly'; // default
        
        if (priceItem?.price?.nickname) {
            planName = priceItem.price.nickname;
        } else if (priceItem?.price?.recurring?.interval) {
            planName = priceItem.price.recurring.interval; 
        }

        // Calcular end_date basado en current_period_end de Stripe
        const startDate = new Date(stripeSubscription.created * 1000);
        const endDate = new Date(stripeSubscription.current_period_end * 1000);

        const subscriptionData = {
            user_id: userId,
            stripe_customer_id: stripeSubscription.customer,
            stripe_subscription_id: stripeSubscription.id,
            status: stripeSubscription.status,
            plan_name: planName,
            start_date: startDate,
            end_date: endDate,
            canceled_date: stripeSubscription.canceled_at 
                ? new Date(stripeSubscription.canceled_at * 1000)
                : null
        };

        // Buscar si ya existe la suscripción por su ID de Stripe
        const { data: existingSubscription, error: existingStripeError } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('stripe_subscription_id', stripeSubscription.id)
            .maybeSingle();

        if (existingStripeError && existingStripeError.code !== 'PGRST116') {
            console.error('⚠️  Error finding subscription by stripe id:', existingStripeError);
        } else if (existingSubscription) {
            subscriptionData.id = existingSubscription.id;
        }

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

        console.log('✅ Subscription upserted successfully:', data);

        // Si la nueva suscripción está activa/trialing/etc., marcar otras suscripciones activas del usuario como canceladas
        const activeLikeStatuses = new Set(['trialing', 'active', 'past_due', 'incomplete']);
        if (activeLikeStatuses.has(stripeSubscription.status)) {
            const { error: deactivateError } = await supabase
                .from('subscriptions')
                .update({
                    status: 'canceled',
                    canceled_date: new Date(),
                    end_date: new Date()
                })
                .eq('user_id', userId)
                .neq('stripe_subscription_id', stripeSubscription.id)
                .not('status', 'eq', 'canceled');

            if (deactivateError) {
                console.error('⚠️  Error marking old subscriptions as canceled:', deactivateError);
            }
        }

        return data;
    } catch (error) {
        console.error('upsertSubscription error:', error);
        throw error;
    }
}

/**
 * Registra un pago en Supabase desde un invoice de Stripe
 */
export async function recordPayment(stripeInvoice, subscription) {
    try {
        console.log('💳 Recording payment in Supabase:', {
            invoice_id: stripeInvoice.id,
            payment_intent: stripeInvoice.payment_intent,
            customer: stripeInvoice.customer,
            amount: stripeInvoice.amount_paid,
            subscription: subscription
        });

        // Buscar el user_id desde el customer de Stripe
        let userId = await getUserIdFromStripeCustomer(stripeInvoice.customer);
        
        if (!userId) {
            userId = await findUserByStripeCustomerId(stripeInvoice.customer);
        }
        
        if (!userId) {
            console.error('❌ Cannot record payment: user_id not found for customer:', stripeInvoice.customer);
            return null;
        }

        const paymentData = {
            user_id: userId,
            subscription_id: subscription, 
            amount: stripeInvoice.amount_paid / 100, // Stripe usa centavos
            stripe_payment_id: stripeInvoice.id, // ID de la factura (invoice.id)
            payment_status: stripeInvoice.status === 'paid' ? 'completed' : 
                           stripeInvoice.status === 'open' ? 'pending' : 'failed',
            transaction_date: new Date(stripeInvoice.created * 1000)
        };

        console.log('💾 Inserting payment data:', paymentData);

        const { data, error } = await supabase
            .from('payments')
            .insert(paymentData)
            .select()
            .single();

        if (error) {
            console.error('❌ Error recording payment:', error);
            throw error;
        }

        console.log('✅ Payment recorded successfully:', data);
        return data;
    } catch (error) {
        console.error('recordPayment error:', error);
        throw error;
    }
}

/**
 * Actualiza el estado de una suscripción
 */
export async function updateSubscriptionStatus(stripeSubscriptionId, status) {
    try {
        console.log('🔄 Updating subscription status:', {
            stripe_subscription_id: stripeSubscriptionId,
            status
        });

        const { data, error } = await supabase
            .from('subscriptions')
            .update({ 
                status,
                end_date: status === 'canceled' ? new Date() : null
            })
            .eq('stripe_subscription_id', stripeSubscriptionId)
            .select()
            .single();

        if (error) {
            console.error('❌ Error updating subscription status:', error);
            throw error;
        }

        console.log('✅ Subscription status updated:', data);
        return data;
    } catch (error) {
        console.error('updateSubscriptionStatus error:', error);
        throw error;
    }
}

/**
 * Obtiene o crea un customer de Stripe para un usuario
 */
export async function getOrCreateStripeCustomer(userId, email, stripe) {
    try {
        // Buscar si ya tiene un customer en Supabase
        const { data: subscription } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('user_id', userId)
            .not('stripe_customer_id', 'is', null)
            .limit(1)
            .single();

        if (subscription?.stripe_customer_id) {
            console.log('✅ Found existing Stripe customer:', subscription.stripe_customer_id);
            return subscription.stripe_customer_id;
        }

        // Crear nuevo customer en Stripe
        console.log('🆕 Creating new Stripe customer for user:', userId);
        const customer = await stripe.customers.create({
            email,
            metadata: {
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
