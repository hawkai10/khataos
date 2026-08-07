import { Badge } from './ui/badge.jsx';

const INVOICE_VARIANTS = {
  captured: 'secondary',
  pending_approval: 'warning',
  approved: 'info',
  scheduled: 'violet',
  paid: 'success',
  rejected: 'destructive',
  validation_failed: 'destructive',
  overdue: 'destructive',
};

const PAYMENT_VARIANTS = {
  pending: 'secondary',
  pending_approval: 'warning',
  approved: 'info',
  scheduled: 'violet',
  executing: 'info',
  processing: 'info',
  completed: 'success',
  failed: 'destructive',
};

const LABELS = {
  captured: 'Captured',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  scheduled: 'Scheduled',
  paid: 'Paid',
  rejected: 'Rejected',
  validation_failed: 'Validation failed',
  pending: 'Pending',
  processing: 'Processing',
  executing: 'Executing',
  completed: 'Completed',
  failed: 'Failed',
  overdue: 'Overdue',
};

export function InvoiceBadge({ status }) {
  return <Badge variant={INVOICE_VARIANTS[status] || 'outline'}>{LABELS[status] || status}</Badge>;
}

export function PaymentBadge({ status }) {
  return <Badge variant={PAYMENT_VARIANTS[status] || 'outline'}>{LABELS[status] || status}</Badge>;
}

export function ModeBadge({ mode }) {
  const colors = {
    UPI: 'success', IMPS: 'info', NEFT: 'default', RTGS: 'violet', CHQ: 'secondary',
  };
  return <Badge variant={colors[mode] || 'outline'}>{mode || '—'}</Badge>;
}
