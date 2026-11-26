@hasSection('crm-ai-writer-enabled')
@php($crmAiScript = app(\App\CrmAi\Bridge::class)->scriptTag())
@if ($crmAiScript)
{!! $crmAiScript !!}
<script>
(() => {
    const crmScript = document.currentScript.previousElementSibling;
    const AIConfig = {
        mount: '#news-ai-writer',
        form: '#news-main-form',
        customStyle: false,
        customClass: '',
        languages: {
            source: 'vi',
            targets: [],
        },
    };

    const initCrmAi = async function () {
        const form = document.querySelector(AIConfig.form);
        const mount = document.querySelector(AIConfig.mount);
        if (!form || !mount) return;

        const sourceLocale = AIConfig.languages.source;

        if (!window.AIWriter) {
            mount.textContent = 'Chưa tải được công cụ viết AI. Hãy tải lại trang.';
            return;
        }

        const slugMultilang = mount.dataset.slugMultilang !== '0';
        const seoMultilang = mount.dataset.seoMultilang !== '0';
        const selector = (name, locale = '$lang') => '[name="' + name + '[' + locale + ']"]';
        const notify = element => {
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const writeEditor = (element, value) => {
            const editor = window.CKEDITOR?.instances[element.id];
            if (!editor) {
                element.value = value;
                notify(element);
                return;
            }
            return new Promise(resolve => {
                editor.setData(value, { callback: function () {
                    this.updateElement();
                    notify(element);
                    resolve();
                } });
            });
        };
        const fields = {};
        const add = (field, name, setter, localized = true) => {
            const target = selector(name, localized ? '$lang' : sourceLocale);
            if (form.querySelector(selector(name, sourceLocale))) fields[field] = setter ? {
                selector: target, setValue: setter,
                getValue: element => window.CKEDITOR?.instances[element.id]?.getData() ?? element.value,
            } : target;
        };
        add('Title', 'name', (element, value) => {
            element.value = value;
            notify(element);
            const locale = element.name.match(/\[([^\]]+)\]$/)?.[1] ?? sourceLocale;
            const seoTitle = form.querySelector(selector('seo[title]', locale));
            if (seoTitle) { seoTitle.value = value; notify(seoTitle); }
        });
        add('Content', 'content', writeEditor);
        add('Desc', 'desc', writeEditor);
        add('Slug', 'slug', (element, value) => {
            // Preserve the website's automatic-slug setting when it is enabled.
            if (!form.querySelector('[data-slug-auto]')?.checked) {
                element.value = value;
                notify(element);
            }
        }, slugMultilang);
        add('Description', 'seo[description]', undefined, seoMultilang);
        add('Keywords', 'seo[keywords]', undefined, seoMultilang);
        add('FocusKeyword', 'seo[focus_keyword]', undefined, seoMultilang);

        try {
            const response = await fetch(crmScript.dataset.credentialsUrl, {
                credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
                headers: { Accept: 'application/json' },
            });
            const own = response.ok ? await response.json() : {};
            Object.assign(AIConfig, own, { fields });
            window.AIWriter.mount(AIConfig);
        } catch (_) {
            mount.textContent = 'Chưa tải được công cụ viết AI. Hãy tải lại trang.';
        }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCrmAi, { once: true });
    else initCrmAi();
})();
</script>
@endif
@endif
