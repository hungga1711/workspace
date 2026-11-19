import defaultMdxComponents from "fumadocs-ui/mdx";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { MDXComponents } from "mdx/types";
import { DIAGRAMS as BASE } from "@/components/diagrams";
import { ADVANCED_DIAGRAMS } from "@/components/diagrams/advanced";

const DIAGRAMS = { ...BASE, ...ADVANCED_DIAGRAMS };

/** An architecture diagram, drawn inline so it follows the theme (src/components/diagrams). */
function Diagram({ name, caption }: { name: keyof typeof DIAGRAMS; caption?: string }) {
  const Svg = DIAGRAMS[name];
  return (
    <figure className="diagram">
      <Svg />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Step,
    Steps,
    Tab,
    Tabs,
    Diagram,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
