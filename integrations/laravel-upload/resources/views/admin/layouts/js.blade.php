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
        fields: {
            Title: '[name="name[$lang]"]',
            SeoTitle: '[name="seo[title][$lang]"]',
            Content: '[name="content[$lang]"]',
            Desc: '[name="desc[$lang]"]',
            Slug: '[name="slug[$lang]"]',
            Description: '[name="seo[description][$lang]"]',
            Keywords: '[name="seo[keywords][$lang]"]',
            FocusKeyword: '[name="seo[focus_keyword][$lang]"]',
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

        let configuredFields = AIConfig.fields;
        if (mount.hasAttribute('data-fields')) {
            try { configuredFields = JSON.parse(mount.dataset.fields) ?? configuredFields; }
            catch (_) {
                mount.textContent = 'Kiểm tra cấu hình fields của trang.';
                return;
            }
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
        const readEditor = element => window.CKEDITOR?.instances[element.id]?.getData() ?? element.value ?? element.textContent ?? '';
        const defaultFields = {};
        const add = (field, name, setter, localized = true) => {
            const target = selector(name, localized ? '$lang' : sourceLocale);
            if (form.querySelector(selector(name, sourceLocale))) defaultFields[field] = setter ? {
                selector: target, setValue: setter,
                getValue: readEditor,
            } : target;
        };
        add('Title', 'name');
        add('SeoTitle', 'seo[title]', undefined, seoMultilang);
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

        const fields = configuredFields == null ? defaultFields : Object.fromEntries(
            Object.entries(configuredFields).map(([field, target]) => [field,
                target && (field === 'Content' || field === 'Desc') ? {
                    setValue: writeEditor,
                    getValue: readEditor,
                    ...(typeof target === 'string' ? { selector: target } : target),
                } : target,
            ]),
        );

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
