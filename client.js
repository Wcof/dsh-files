window.__ModuleLoader__.load({
  id: '@dsh/files',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const id = 'dsh-files-panel';
    const copy = {
      zh: { title: '文件', loading: '正在打开文件…', error: '文件页面不可用，请确认插件已启用并重启窗口。', retry: '重试' },
      en: { title: 'Files', loading: 'Opening files…', error: 'The files page is unavailable. Check that the plugin is enabled and restart the window.', retry: 'Retry' },
    };
    function FolderIcon({ size = 18 } = {}) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z', strokeLinejoin: 'round' }));
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('dshFiles', copy), 'dsh-files:locale');
        const t = ctx.locale.bind('dshFiles');
        function FilesPanel() {
          const [state, setState] = React.useState('loading');
          const [attempt, retry] = React.useState(0);
          const language = t('title') === '文件' ? 'zh' : 'en';
          React.useEffect(() => {
            const controller = new AbortController();
            setState('loading');
            fetch('/dsh-files/', { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
              .then(response => { if (!controller.signal.aborted) setState(response.ok ? 'ready' : 'error'); })
              .catch(() => { if (!controller.signal.aborted) setState('error'); });
            return () => controller.abort();
          }, [attempt]);
          if (state === 'ready') return h('iframe', {
            title: t('title'), src: `/dsh-files/?lang=${language}`,
            style: { width: '100%', height: '100%', border: 0, display: 'block', colorScheme: 'light dark' },
          });
          return h('div', { role: 'status', style: { padding: 24, color: 'inherit' } },
            h('p', null, t(state === 'error' ? 'error' : 'loading')),
            state === 'error' ? h('button', { type: 'button', onClick: () => retry(n => n + 1) }, t('retry')) : null);
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id, order: 20, label: () => t('title'), locale: 'dshFiles' }, FolderIcon));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id, locale: 'dshFiles' }, FilesPanel));
      },
    };
  },
});
