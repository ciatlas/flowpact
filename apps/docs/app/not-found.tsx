import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { DefaultNotFound } from 'fumadocs-ui/layouts/home/not-found';
import { baseOptions } from '@/lib/layout.shared';

/** The page GitHub Pages serves for a URL the site does not have (out/404.html). */
export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <DefaultNotFound />
    </HomeLayout>
  );
}
