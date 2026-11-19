import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { Provider } from '@/components/provider';
import './docs.css';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  // The docs alone need Fumadocs' provider (theme, search dialog); keeping it out of the root layout keeps its
  // JavaScript off the landing page.
  return (
    <Provider>
      <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
        {children}
      </DocsLayout>
    </Provider>
  );
}
