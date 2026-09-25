/** Ways a customer can pay. `bank_transfer` is a one-time virtual account issued by the gateway. */
export const PAYMENT_METHODS = ['card', 'bank_transfer', 'ussd', 'wallet'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  card: 'Card',
  bank_transfer: 'Bank transfer (virtual account)',
  ussd: 'USSD',
  wallet: 'HANDIWORK wallet',
};

export const GATEWAYS = ['stripe', 'paystack', 'flutterwave', 'mock'] as const;
export type Gateway = (typeof GATEWAYS)[number];
