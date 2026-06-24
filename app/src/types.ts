export type Role = 'employee' | 'manager' | 'finance' | 'admin';
export type ExpenseType = 'reimbursement' | 'company_paid';
export type ExpenseStatus =
  | 'draft'
  | 'submitted'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'paid'
  | 'withdrawn';
export type StepStatus = 'pending' | 'approved' | 'rejected' | 'skipped';

export interface User {
  id: string;
  org_id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  manager_id: string | null;
  is_active: boolean;
  created_at: string;
}

export interface AuthUser {
  id: string;
  org_id: string;
  role: Role;
  email: string;
}

export interface PolicyRule {
  min: number;
  max: number | null;
  levels: Role[];
}

export interface Policy {
  id: string;
  org_id: string;
  name: string;
  rules_json: { currency?: string; rules: PolicyRule[] };
  tolerance_percent: number;
  active: boolean;
  version: number;
  created_at: string;
}

export interface ExpenseRequest {
  id: string;
  org_id: string;
  requester_id: string;
  type: ExpenseType;
  category: string;
  description: string;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
  status: ExpenseStatus;
  policy_snapshot_json: { rules: PolicyRule[] } | null;
  current_level: number;
  sla_due_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalStep {
  id: string;
  org_id: string;
  expense_id: string;
  level: number;
  required_role: Role;
  approver_id: string | null;
  status: StepStatus;
  reason: string | null;
  acted_at: string | null;
  sla_due_at: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
