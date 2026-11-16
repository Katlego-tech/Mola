import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import en from './en.json';
import { LANGS, type Lang } from './langs';

type Key = keyof typeof en;
type Catalog = Partial<Record<Key, string>> & { _meta?: unknown };
type Catalogs = Partial<Record<Lang, Catalog>> & { en: Catalog };
type Vars = Record<string, string | number>;

const modules = import.meta.glob('./*.json', { eager: true, import: 'default' });
const shipped: Catalogs = { en };
for (const lang of Object.keys(LANGS) as Lang[]) {
  const catalog = modules[`./${lang}.json`];
  if (catalog) shipped[lang] = catalog as Catalog;
}

function translate(catalog: Catalog, key: Key, vars: Vars = {}): string {
  return (catalog[key] ?? en[key]).replace(/\{([^{}]+)\}/g, (placeholder: string, name: string) =>
    vars[name] === undefined ? placeholder : String(vars[name]));
}

interface LanguageContext {
  t(key: Key, vars?: Vars): string;
  lang: Lang;
  setLang(lang: Lang): void;
  available: Lang[];
}
const LangContext = createContext<LanguageContext | null>(null);

export function LangProvider({ children, catalogs = shipped }: { children: ReactNode; catalogs?: Catalogs }) {
  const available = (Object.keys(LANGS) as Lang[]).filter((lang) => catalogs[lang] !== undefined);
  const [lang, updateLang] = useState<Lang>(() => {
    try {
      const stored = localStorage.getItem('mola:lang');
      if (available.includes(stored as Lang)) return stored as Lang;
    } catch { /* Storage may be disabled. */ }
    for (const language of navigator.languages) {
      const candidate = language.toLowerCase().split('-')[0] as Lang;
      if (available.includes(candidate)) return candidate;
    }
    return 'en';
  });
  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem('mola:lang', lang);
    } catch { /* Storage may be disabled. */ }
  }, [lang]);
  const setLang = (next: Lang) => {
    if (available.includes(next)) updateLang(next);
  };
  return (
    <LangContext.Provider value={{ lang, setLang, available, t: (key, vars) => translate(catalogs[lang] ?? en, key, vars) }}>
      {children}
    </LangContext.Provider>
  );
}

export function useT() {
  const context = useContext(LangContext);
  if (!context) throw new Error('Patron copy requires a language provider');
  return context;
}
