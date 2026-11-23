import { useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Skeleton, Space, Switch, Table } from 'antd';
import { AnthropicFilled, ApiOutlined, CheckOutlined, DeleteOutlined, EditOutlined, KeyOutlined, OpenAIOutlined, PlusOutlined } from '@ant-design/icons';
import { mutate, useResource } from './api';
import { EmptyState, PageHeading, Panel, ResourceError } from './shared';
import type { CatalogModel, CatalogProvider, Collection } from './types';
import './records.css';

function isCompatible(provider: CatalogProvider) {
  return provider.kind === 'openai-compatible' || provider.provider === 'openai-compatible' || provider.provider.startsWith('openai-compatible-');
}

function keyConfigured(provider?: CatalogProvider) {
  return Boolean(provider?.api_key_configured || provider?.service_key_configured);
}

const connectionTypes = [
  { provider: 'openai', display_name: 'OpenAI' },
  { provider: 'anthropic', display_name: 'Anthropic' },
  { provider: 'xai', display_name: 'xAI' },
  { provider: 'openai-compatible', display_name: 'OpenAI Compatible' },
];

function connectionName(provider: CatalogProvider) {
  return provider.provider === 'openai-compatible' && provider.display_name === 'OpenAI Compatible'
    ? 'Kết nối mặc định' : provider.display_name;
}

type ProviderFormValues = { display_name?: string; base_url?: string; api_key?: string };

function ProviderMark({ provider }: { provider: CatalogProvider }) {
  return <span className={'record-provider-mark mark-' + (provider.kind ?? (isCompatible(provider) ? 'openai-compatible' : provider.provider))} aria-hidden="true">
    {provider.provider === 'openai' ? <OpenAIOutlined /> : provider.provider === 'anthropic' ? <AnthropicFilled /> : provider.provider === 'xai' ? 'xAI' : 'API'}
  </span>;
}

export function Providers() {
  const catalog = useResource<Collection<CatalogProvider>>('/providers');
  const [connectionType, setConnectionType] = useState('openai');
  const [selection, setSelection] = useState('openai-compatible');
  const [editor, setEditor] = useState<{ provider: CatalogProvider; model?: CatalogModel }>();
  const [providerEditor, setProviderEditor] = useState<{ provider?: CatalogProvider }>();
  const [busy, setBusy] = useState<string>();
  const [form] = Form.useForm<CatalogModel>();
  const [providerForm] = Form.useForm<ProviderFormValues>();
  const { message } = App.useApp();
  const providers = catalog.data?.data ?? [];
  const compatibleProviders = providers.filter(isCompatible);
  const selected = connectionType === 'openai-compatible'
    ? compatibleProviders.find((item) => item.provider === selection) ?? compatibleProviders[0]
    : providers.find((item) => item.provider === connectionType);

  function edit(provider: CatalogProvider, model?: CatalogModel) {
    setEditor({ provider, model });
    form.resetFields();
    form.setFieldsValue(model ? { ...model, model: model.upstream_model ?? model.model } : { enabled: true });
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

  function removeModel(provider: CatalogProvider, model: CatalogModel) {
    Modal.confirm({
      title: 'Xóa model này?',
      content: `Model ${model.upstream_model ?? model.model} sẽ bị xóa khỏi danh sách của ${provider.display_name}.`,
      okText: 'Xóa model',
      cancelText: 'Hủy',
      okButtonProps: { danger: true },
      onOk: async () => {
        const key = 'delete-model/' + model.model;
        setBusy(key);
        try {
          await mutate('/providers/' + provider.provider + '/models/' + encodeURIComponent(model.model), 'DELETE');
          catalog.reload();
          message.success('Đã xóa model.');
        } catch (error) {
          message.error((error as Error).message);
          throw error;
        } finally {
          setBusy(undefined);
        }
      },
    });
  }

  function editProvider(provider?: CatalogProvider) {
    setProviderEditor({ provider });
    providerForm.resetFields();
    providerForm.setFieldsValue({ display_name: provider?.display_name ?? '', base_url: provider?.base_url ?? '', api_key: undefined });
  }

  async function saveProvider(values: ProviderFormValues) {
    if (!providerEditor) return;
    const provider = providerEditor.provider;
    const body: ProviderFormValues & { enabled?: boolean } = {};
    if (!provider || isCompatible(provider)) {
      body.display_name = values.display_name?.trim();
      body.base_url = values.base_url?.trim();
    }
    if (values.api_key?.trim()) body.api_key = values.api_key.trim();
    if (!provider) body.enabled = true;
    setBusy('provider-editor');
    try {
      const result = await mutate<CatalogProvider>(provider ? '/providers/' + encodeURIComponent(provider.provider) : '/providers', provider ? 'PATCH' : 'POST', body);
      if (!provider) { setConnectionType('openai-compatible'); setSelection(result.provider); }
      catalog.reload();
      setProviderEditor(undefined);
      message.success(provider ? 'Đã lưu cấu hình nhà cung cấp.' : 'Đã thêm provider OpenAI Compatible.');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function checkProvider(provider: CatalogProvider) {
    setBusy('provider-check');
    try {
      const result = await mutate<{ message: string }>('/providers/' + encodeURIComponent(provider.provider) + '/check', 'POST');
      message.success(result.message);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function pingModel(provider: CatalogProvider, model: CatalogModel) {
    const key = 'ping-model/' + model.model;
    setBusy(key);
    try {
      const result = await mutate<{ message: string }>('/providers/' + encodeURIComponent(provider.provider) + '/models/' + encodeURIComponent(model.model) + '/ping', 'POST');
      message.success(result.message);
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
    {catalog.data && <>
      <nav className="record-providers" aria-label="Chọn dạng kết nối AI">
        {connectionTypes.map((type) => {
          const members = type.provider === 'openai-compatible' ? compatibleProviders : providers.filter(item => item.provider === type.provider);
          const models = members.flatMap(item => item.models);
          const active = members.flatMap(item => item.enabled ? item.models.filter(model => model.enabled) : []).length;
          const item: CatalogProvider = { ...type, enabled: members.some(item => item.enabled), models, service_key_configured: false };
          return <button key={type.provider} type="button" aria-pressed={connectionType === type.provider}
            onClick={() => setConnectionType(type.provider)}>
            <ProviderMark provider={item} />
            <span className="record-provider-info"><strong>{type.display_name}</strong>
              <small>{type.provider === 'openai-compatible'
                ? `${members.length} provider · ${active}/${models.length} model`
                : members.length ? item.enabled ? <>{active}/{models.length} model<span className="record-wide-label"> đang cung cấp</span></> : 'Đã tắt' : 'Chưa cấu hình'}</small>
            </span>
            {connectionType === type.provider && <CheckOutlined className="record-provider-check" />}
          </button>;
        })}
      </nav>
      {connectionType === 'openai-compatible' && <Panel className="record-compatible-group" title="Provider OpenAI Compatible"
        extra={<Button type="primary" icon={<PlusOutlined />} disabled={Boolean(busy) || catalog.loading} onClick={() => editProvider()}>Thêm provider</Button>}>
        <p className="record-compatible-description">Mỗi provider có Base URL, API key và danh sách model riêng.</p>
        {compatibleProviders.length ? <nav className="record-compatible-providers" aria-label="Chọn provider OpenAI Compatible">
          {compatibleProviders.map(provider => <button key={provider.provider} type="button"
            aria-pressed={selected?.provider === provider.provider} onClick={() => setSelection(provider.provider)}>
            <span className="record-compatible-identity"><strong>{connectionName(provider)}</strong>
              <small className="mono">{provider.base_url || 'Chưa cấu hình Base URL'}</small></span>
            <span className="record-compatible-status">{provider.enabled ? `${provider.models.filter(model => model.enabled).length}/${provider.models.length} model` : 'Đã tắt'}</span>
            {selected?.provider === provider.provider && <CheckOutlined aria-hidden="true" />}
          </button>)}
        </nav> : <EmptyState description="Chưa có provider OpenAI Compatible" />}
      </Panel>}
      {!selected && connectionType !== 'openai-compatible' && <Panel><EmptyState description="Chưa cấu hình nhà cung cấp này" /></Panel>}
      {selected && <Panel className="record-provider-detail" title={isCompatible(selected) ? connectionName(selected) : selected.display_name} extra={<label className="record-provider-toggle">
        <span>Cho phép cung cấp</span>
        <Switch checked={selected.enabled} loading={busy === 'provider/' + selected.provider} disabled={Boolean(busy) || catalog.loading}
          aria-label={'Cho phép cung cấp ' + selected.display_name} onChange={(value) => void setEnabled(selected, value)} />
      </label>}>
        <Space className="record-provider-key" size={8} wrap>
          <span><KeyOutlined /> {isCompatible(selected) ? 'API key' : 'Key dịch vụ'} {isCompatible(selected)
            ? (keyConfigured(selected) ? 'đã cấu hình' : 'chưa cấu hình')
            : (selected.service_key_configured ? 'đã cấu hình' : 'chưa cấu hình')}</span>
          <Button size="small" onClick={() => editProvider(selected)} disabled={Boolean(busy) || catalog.loading}>
            {isCompatible(selected) ? 'Cấu hình kết nối' : 'Cấu hình key'}
          </Button>
          {isCompatible(selected) && <Button size="small" loading={busy === 'provider-check'}
            onClick={() => void checkProvider(selected)} disabled={Boolean(busy) || catalog.loading}>Kiểm tra kết nối</Button>}
        </Space>
        {isCompatible(selected) && <p className="record-provider-endpoint">
          Base URL <span className="mono">{selected.base_url || 'Chưa cấu hình'}</span>
        </p>}
        {!selected.enabled && <Alert className="record-provider-note" type="info" showIcon
          title="Bật nhà cung cấp để các model đã chọn xuất hiện trên website khách hàng." />}
        <div className="record-models-heading"><h3>Danh sách model <span>{selected.models.length}</span></h3>
          <Button type="primary" icon={<PlusOutlined />} disabled={Boolean(busy) || catalog.loading} onClick={() => edit(selected)}>Thêm model</Button>
        </div>
        <Table<CatalogModel> rowKey="model" size="middle" dataSource={selected.models} pagination={false}
          locale={{ emptyText: <EmptyState description="Nhà cung cấp này chưa có model" /> }}
          columns={[
            { title: 'Model', key: 'model', render: (_, row) => <div className="table-identity record-model">
              <strong>{row.display_name}</strong><small className="mono">{row.upstream_model ?? row.model}</small>
            </div> },
            { title: 'Bật model', key: 'enabled', align: 'center', width: 85, render: (_, row) => <Switch checked={row.enabled}
              loading={busy === 'model/' + row.model} disabled={Boolean(busy) || catalog.loading}
              aria-label={'Bật model ' + (row.upstream_model ?? row.model)} onChange={(value) => void setEnabled(selected, value, row)} /> },
            { title: '', key: 'actions', width: isCompatible(selected) ? 132 : 96, align: 'right', render: (_, row) => <Space size={2}>{isCompatible(selected) && <Button type="text" icon={<ApiOutlined />}
              aria-label={'Ping model ' + (row.upstream_model ?? row.model)} title="Kiểm tra model" loading={busy === 'ping-model/' + row.model} disabled={Boolean(busy) || catalog.loading}
              onClick={() => void pingModel(selected, row)} />}
              <Button type="text" icon={<EditOutlined />}
              aria-label={'Chỉnh sửa ' + (row.upstream_model ?? row.model)} title="Chỉnh sửa tên hiển thị" disabled={Boolean(busy) || catalog.loading}
              onClick={() => edit(selected, row)} />
              <Button type="text" danger icon={<DeleteOutlined />}
              aria-label={'Xóa ' + (row.upstream_model ?? row.model)} title="Xóa model" loading={busy === 'delete-model/' + row.model} disabled={Boolean(busy) || catalog.loading}
              onClick={() => removeModel(selected, row)} /></Space> },
          ]} />
      </Panel>}
    </>}
    <Modal open={Boolean(editor)} forceRender title={(editor?.model ? 'Chỉnh sửa model' : 'Thêm model') + ' · ' + (editor?.provider.display_name ?? '')}
      okText="Lưu model" cancelText="Hủy" onOk={() => form.submit()} confirmLoading={busy === 'editor'}
      onCancel={() => { if (busy !== 'editor') setEditor(undefined); }}>
      <Form name="provider-model" form={form} layout="vertical" onFinish={save} disabled={busy === 'editor'}>
        <Form.Item label="Mã model" name="model" extra={editor?.model ? undefined : 'Dùng đúng mã model trong API của nhà cung cấp.'}
          rules={[{ required: true, whitespace: true, message: 'Nhập mã model.' }, { pattern: /^[a-zA-Z0-9._/-]+$/, message: 'Dùng chữ cái, chữ số, dấu chấm, gạch chéo, gạch nối hoặc gạch dưới.' }]}>
          <Input disabled={Boolean(editor?.model)} maxLength={160} autoComplete="off" spellCheck={false} />
        </Form.Item>
        <Form.Item label="Tên hiển thị" name="display_name" rules={[{ required: true, whitespace: true, message: 'Nhập tên hiển thị.' }]}>
          <Input maxLength={160} />
        </Form.Item>
        {!editor?.model && <Form.Item label="Bật model" name="enabled" valuePropName="checked"><Switch /></Form.Item>}
      </Form>
    </Modal>
    <Modal open={Boolean(providerEditor)} forceRender title={providerEditor?.provider ? 'Cấu hình kết nối · ' + providerEditor.provider.display_name : 'Thêm provider OpenAI Compatible'}
      okText="Lưu cấu hình" cancelText="Hủy" onOk={() => providerForm.submit()} confirmLoading={busy === 'provider-editor'}
      onCancel={() => { if (busy !== 'provider-editor') setProviderEditor(undefined); }}>
      <Form name="provider-connection" form={providerForm} layout="vertical" onFinish={saveProvider} disabled={busy === 'provider-editor'}>
        {providerEditor && (!providerEditor.provider || isCompatible(providerEditor.provider)) && <>
        <Form.Item label="Tên provider" name="display_name" rules={[{ required: true, whitespace: true, message: 'Nhập tên provider.' }]}>
          <Input placeholder="Ví dụ: Gateway nội bộ" maxLength={160} autoComplete="off" />
        </Form.Item>
        <Form.Item label="Base URL" name="base_url"
          extra="Địa chỉ API tương thích OpenAI, ví dụ https://api.example.com/v1"
          rules={[
            { required: true, whitespace: true, message: 'Nhập Base URL.' },
            { type: 'url', message: 'Base URL phải là một URL hợp lệ.' },
          ]}>
          <Input placeholder="https://api.example.com/v1" maxLength={500} autoComplete="url" />
        </Form.Item></>}
        <Form.Item label="API key" name="api_key" extra={keyConfigured(providerEditor?.provider) ? 'Để trống để giữ key khi Base URL không đổi. Khi đổi Base URL, cần nhập lại API key.' : 'API key dùng để gọi nhà cung cấp này.'}
          rules={keyConfigured(providerEditor?.provider) ? undefined : [{ required: true, whitespace: true, message: 'Nhập API key.' }]}>
          <Input.Password placeholder={keyConfigured(providerEditor?.provider) ? 'Nhập lại key nếu đổi Base URL' : 'Nhập API key'} maxLength={2048} autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  </>;
}
