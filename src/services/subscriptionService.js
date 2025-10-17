import supabase from '../config/supabase.js';

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

        if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
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

        // Si no tenemos userId, intentamos encontrarlo
        if (!userId) {
            userId = await findUserByStripeCustomerId(stripeSubscription.customer);
        }

        if (!userId) {
            console.error('❌ Cannot upsert subscription: user_id not found for customer:', stripeSubscription.customer);
            return null;
        }

        const subscriptionData = {
            user_id: userId,
            stripe_customer_id: stripeSubscription.customer,
            stripe_subscription_id: stripeSubscription.id,
            status: stripeSubscription.status,
            current_period_start: new Date(stripeSubscription.current_period_start * 1000),
            current_period_end: new Date(stripeSubscription.current_period_end * 1000),
            cancel_at_period_end: stripeSubscription.cancel_at_period_end || false,
            plan_name: stripeSubscription.items?.data[0]?.price?.nickname || 'monthly',
            start_date: new Date(stripeSubscription.created * 1000),
            end_date: stripeSubscription.cancel_at_period_end 
                ? new Date(stripeSubscription.current_period_end * 1000)
                : null
        };

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
        return data;
    } catch (error) {
        console.error('upsertSubscription error:', error);
        throw error;
    }
}

/**
 * Registra un pago en Supabase desde un invoice de Stripe
 */
export async function recordPayment(stripeInvoice) {
    try {
        console.log('💳 Recording payment in Supabase:', {
            payment_intent: stripeInvoice.payment_intent,
            customer: stripeInvoice.customer,
            amount: stripeInvoice.amount_paid
        });

        // Buscar el user_id
        const userId = await findUserByStripeCustomerId(stripeInvoice.customer);
        
        if (!userId) {
            console.error('❌ Cannot record payment: user_id not found for customer:', stripeInvoice.customer);
            return null;
        }

        // Buscar la subscription_id en Supabase
        const { data: subscription, error: subError } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('stripe_subscription_id', stripeInvoice.subscription)
            .single();

        if (subError && subError.code !== 'PGRST116') {
            console.error('Error finding subscription:', subError);
        }

        const paymentData = {
            user_id: userId,
            subscription_id: subscription?.id || null,
            amount: stripeInvoice.amount_paid / 100, // Stripe usa centavos
            currency: stripeInvoice.currency,
            stripe_payment_intent_id: stripeInvoice.payment_intent,
            gateway_transaction_id: stripeInvoice.payment_intent, // Mantener compatibilidad
            payment_status: stripeInvoice.status === 'paid' ? 'completed' : 'pending',
            transaction_date: new Date(stripeInvoice.created * 1000)
        };

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
