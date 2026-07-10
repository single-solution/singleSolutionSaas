import { FlatCompat } from "@eslint/eslintrc";

const compatibility = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      ".npm-cache/**",
      "node_modules/**",
      "products/**",
      "next-env.d.ts",
    ],
  },
  ...compatibility.extends("next/core-web-vitals", "next/typescript"),
];

export default eslintConfig;
