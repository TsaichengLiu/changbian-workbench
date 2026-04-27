declare module "opencc-js" {
  interface LocaleConfig {
    from: "cn" | "tw" | "twp" | "hk" | "jp" | "t";
    to: "cn" | "tw" | "twp" | "hk" | "jp" | "t";
  }

  export function Converter(config: LocaleConfig): (text: string) => string;
}
