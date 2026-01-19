export type Currency = "IQD" | "USD";
export type Role = "admin" | "staff" | "customer";

export const CURRENCIES = {
  IQD: "IQD" as Currency,
  USD: "USD" as Currency,
};

export const ROLES = {
  ADMIN: "admin" as Role,
  STAFF: "staff" as Role,
  CUSTOMER: "customer" as Role,
};

export const COMMANDS = {
  START: "/start",
  HELP: "/help",
  LINK: "/link",
  ME: "/me",

  ADD_STAFF: "/addstaff",
  REMOVE_STAFF: "/removestaff",

  ADD_CUSTOMER: "/addcustomer",
  DELETE_CUSTOMER: "/deletecustomer",

  CUSTOMER: "/customer",
  ADD_DEBT: "/adddebt",
  ADD_PAYMENT: "/pay",

  REPORT: "/report"
} as const;

export function isAdmin(env: { ADMIN_TG_ID?: string }, tgId: number): boolean {
  const raw = String(env.ADMIN_TG_ID || "").trim();
  if (!raw) return false;
  return raw === String(tgId);
}