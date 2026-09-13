import type { Env } from "./types";

/** D1 datetime('now') 係 UTC「YYYY-MM-DD HH:MM:SS」，轉做用戶時區嘅日期 */
export function localDate(env: Env, utcSql: string): string {
  const d = new Date(utcSql.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return utcSql.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: env.TIMEZONE }).format(d);
}

/** 而家喺用戶時區係幾多點（0-23） */
export function localHour(env: Env): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: env.TIMEZONE,
    hour: "numeric",
    hourCycle: "h23",
  }).format(new Date());
  return Number(h);
}

export function today(env: Env): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: env.TIMEZONE }).format(new Date());
}
