import { moment } from "obsidian";
import en from "./i18n/en";
import zhCn from "./i18n/zh-cn";

// 映射表
const locales: { [key: string]: Partial<typeof en> } = {
  en,
  "zh-cn": zhCn,
};

// 获取系统语言
const systemLocale = locales[moment.locale()] ? locales[moment.locale()] : "en";

// 翻译
export function t(str: keyof typeof en): string {
    if (!systemLocale || systemLocale == 'en') {
        return en[str];
    }
    return systemLocale[str] || en[str];
}