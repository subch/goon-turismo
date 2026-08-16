import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://goon-turismo.com',
  outDir: './dist',
  build: {
    format: 'directory',
  },
});
