import { useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Skeleton, Switch, Table } from 'antd';
import { AnthropicFilled, CheckOutlined, EditOutlined, KeyOutlined, OpenAIOutlined, PlusOutlined } from '@ant-design/icons';
import { mutate, useResource } from './api';
import { EmptyState, PageHeading, Panel, ResourceError } from './shared';
import type { CatalogModel, CatalogProvider, Collection } from './types';
import './records.css';

function ProviderMark({ provider }: { provider: CatalogProvider }) {
  return <span className={'record-provider-mark mark-' + provider.provider} aria-hidden="true">
    {provider.provider === 'openai' ? <OpenAIOutlined /> : provider.provider === 'anthropic' ? <AnthropicFilled /> : provider.provider === 'xai' ? 'xAI' : provider.display_name.charAt(0)}
  </span>;
}

export function Providers() {
  const catalog = useResource<Collection<CatalogProvider>>('/providers');
  const [selection, setSelection] = useState('openai');
  const [editor, setEditor] = useState<{ provider: CatalogProvider; model?: CatalogModel }>();
  const [busy, setBusy] = useState<string>();
  const [form] = Form.useForm<CatalogModel>();
  const { message } = App.useApp();
  const providers = catalog.data?.data ?? [];
  const selected = providers.find((item) => item.provider === selection) ?? providers[0];

  function edit(provider: CatalogProvider, model?: CatalogModel) {
    setEditor({ provider, model });
    form.resetFields();
    form.setFieldsValue(model ?? { enabled: true });
  }

  async function setEnabled(provider: CatalogProvider, enabled: boolean, model?: CatalogModel) {
    const path = '/providers/' + provider.provider + (model ? '/models/' + encodeURIComponent(model.model) : '');
    setBusy(model ? 'model/' + model.model : 'provider/' + provider.provider);
    try {
      await mutate(path, 'PATCH', { enabled });
      catalog.reload();
      message.success((enabled ? 'Đã bật ' : 'Đã tắt ') + (model?.display_name ?? provider.display_name) + '.');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function save(values: CatalogModel) {
    if (!editor) return;
    const base = '/providers/' + editor.provider.provider + '/models';
    const displayName = values.display_name.trim();
    setBusy('editor');
    try {
      if (editor.model) {
        await mutate(base + '/' + encodeURIComponent(editor.model.model), 'PATCH', { display_name: displayName });
      } else {
        await mutate(base, 'POST', { model: values.model.trim(), display_name: displayName, enabled: values.enabled });
      }
      catalog.reload();
      setEditor(undefined);
      message.success('Đã lưu model.');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return <>
    <PageHeading title="Nhà cung cấp AI" description="Chọn những model mà website khách hàng có thể sử dụng để viết bài." />
    <ResourceError error={catalog.error} onRetry={catalog.reload} />
    {!catalog.data && catalog.loading && <Panel><Skeleton active paragraph={{ rows: 4 }} /></Panel>}
    {catalog.data && !selected && <Panel><EmptyState description="Chưa có nhà cung cấp AI" /></Panel>}
    {selected && <>
      <nav className="record-providers" aria-label="Chọn nhà cung cấp AI">
        {providers.map((item) => {
          const active = item.enabled ? item.models.filter((model) => model.enabled).length : 0;
          return <button key={item.provider} type="button" aria-pressed={selected.provider === item.provider}
            onClick={() => setSelection(item.provider)}>
            <ProviderMark provider={item} />
            <span className="record-provider-info"><strong>{item.display_name}</strong>
              <small>{item.enabled ? <>{active}/{item.models.length} model<span className="record-wide-label"> đang cung cấp</span></> : 'Đã tắt'}</small>
            </span>
            {selected.provider === item.provider && <CheckOutlined className="record-provider-check" />}
          </button>;
        })}
      </nav>
      <Panel className="record-provider-detail" title={selected.display_name} extra={<label className="record-provider-toggle">
        <span>Cho phép cung cấp</span>
        <Switch checked={selected.enabled} loading={busy === 'provider/' + selected.provider} disabled={Boolean(busy) || catalog.loading}
          aria-label={'Cho phép cung cấp ' + selected.display_name} onChange={(value) => void setEnabled(selected, value)} />
      </label>}>
        <p className="record-provider-key"><KeyOutlined /> Key dịch vụ {selected.service_key_configured ? 'đã cấu hình' : 'chưa cấu hình'}</p>
        {!selected.enabled && <Alert className="record-provider-note" type="info" showIcon
          title="Bật nhà cung cấp để các model đã chọn xuất hiện trên website khách hàng." />}
        <div className="record-models-heading"><h3>Danh sách model <span>{selected.models.length}</span></h3>
          <Button type="primary" icon={<PlusOutlined />} disabled={Boolean(busy) || catalog.loading} onClick={() => edit(selected)}>Thêm model</Button>
        </div>
        <Table<CatalogModel> rowKey="model" size="middle" dataSource={selected.models} pagination={false}
          locale={{ emptyText: <EmptyState description="Nhà cung cấp này chưa có model" /> }}
          columns={[
            { title: 'Model', key: 'model', render: (_, row) => <div className="table-identity record-model">
              <strong>{row.display_name}</strong><small className="mono">{row.model}</small>
            </div> },
            { title: 'Bật model', key: 'enabled', align: 'center', width: 85, render: (_, row) => <Switch checked={row.enabled}
              loading={busy === 'model/' + row.model} disabled={Boolean(busy) || catalog.loading}
              aria-label={'Bật model ' + row.model} onChange={(value) => void setEnabled(selected, value, row)} /> },
            { title: '', key: 'edit', width: 56, align: 'right', render: (_, row) => <Button type="text" icon={<EditOutlined />}
              aria-label={'Chỉnh sửa ' + row.model} title="Chỉnh sửa tên hiển thị" disabled={Boolean(busy) || catalog.loading}
              onClick={() => edit(selected, row)} /> },
          ]} />
      </Panel>
    </>}
    <Modal open={Boolean(editor)} forceRender title={(editor?.model ? 'Chỉnh sửa model' : 'Thêm model') + ' · ' + (editor?.provider.display_name ?? '')}
      okText="Lưu model" cancelText="Hủy" onOk={() => form.submit()} confirmLoading={busy === 'editor'}
      onCancel={() => { if (busy !== 'editor') setEditor(undefined); }}>
      <Form form={form} layout="vertical" onFinish={save} disabled={busy === 'editor'}>
        <Form.Item label="Mã model" name="model" extra={editor?.model ? undefined : 'Dùng đúng mã model trong API của nhà cung cấp.'}
          rules={[{ required: true, whitespace: true, message: 'Nhập mã model.' }, { pattern: /^[a-zA-Z0-9._-]+$/, message: 'Dùng chữ cái, chữ số, dấu chấm, gạch nối hoặc gạch dưới.' }]}>
          <Input disabled={Boolean(editor?.model)} maxLength={160} autoComplete="off" spellCheck={false} />
        </Form.Item>
        <Form.Item label="Tên hiển thị" name="display_name" rules={[{ required: true, whitespace: true, message: 'Nhập tên hiển thị.' }]}>
          <Input maxLength={160} />
        </Form.Item>
        {!editor?.model && <Form.Item label="Bật model" name="enabled" valuePropName="checked"><Switch /></Form.Item>}
      </Form>
    </Modal>
  </>;
}
