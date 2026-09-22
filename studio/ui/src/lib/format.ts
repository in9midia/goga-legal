export const usd = (n: number | null | undefined, digits = 4) =>
  n == null ? "—" : `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: n > 0 && n < 0.01 ? digits : 2, maximumFractionDigits: n > 0 && n < 0.01 ? digits : 2 })}`;
export const int = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("pt-BR"));
export const dateTime = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
export const ms = (n: number | null | undefined) => (n == null ? "—" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
