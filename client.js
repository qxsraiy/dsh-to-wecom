(() => {
  try {
    /* dsh-wecom-notify client half：右上角会话推送开关 + 插件设置页（推送服务配置） */
    window.__ModuleLoader__.load({
      id: 'dsh-wecom-notify',
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        var react = require('react');
        var h = react.createElement;
        // 同源 /api 路由（Host 侧挂在 DSH 自己的 connection.fetch 上，不需要额外端口）
        var ENDPOINT = '/api/dsh-to-wecom';

        function op(name, extra) {
          var payload = Object.assign({ op: name }, extra || {});
          return fetch(ENDPOINT, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          });
        }

        var BTN = {
          display: 'inline-flex', alignItems: 'center', gap: '5px',
          padding: '2px 8px', borderRadius: '999px',
          border: '1px solid rgba(127,127,127,0.35)',
          background: 'rgba(127,127,127,0.10)',
          color: 'inherit', fontSize: '11px', lineHeight: '16px',
          fontFamily: 'inherit', cursor: 'pointer', userSelect: 'none',
          whiteSpace: 'nowrap'
        };
        var DOT = { width: '6px', height: '6px', borderRadius: '50%', flex: 'none' };

        /* ── 右上角：只播当前会话 ───────────────────────────────────── */
        function SessionNotifyButton(props) {
          var session = props.session || props.sessionSnapshot || null;
          var propId = (session && (session.id || session.sessionId)) || props.sessionId || '';
          var idPair = react.useState(propId);
          var sessionId = idPair[0];
          var setId = idPair[1];
          var dataPair = react.useState(null);
          var data = dataPair[0];
          var setData = dataPair[1];
          var errPair = react.useState('');
          var error = errPair[0];
          var setError = errPair[1];
          var busyPair = react.useState(false);
          var busy = busyPair[0];
          var setBusy = busyPair[1];

          react.useEffect(function () { if (propId && propId !== sessionId) setId(propId); }, [propId]);

          var load = react.useCallback(function () {
            return op('state', sessionId ? { sessionId: sessionId } : {}).then(function (payload) {
              if (!sessionId && payload.session && payload.session.sessionId) setId(payload.session.sessionId);
              setData(payload);
              setError('');
            }).catch(function (err) { setError(String(err && err.message ? err.message : err)); });
          }, [sessionId]);

          react.useEffect(function () {
            var alive = true;
            void load();
            var timer = setInterval(function () { if (alive) void load(); }, 15000);
            return function () { alive = false; clearInterval(timer); };
          }, [load]);

          function toggle() {
            if (busy) return;
            setBusy(true);
            var request = sessionId
              ? op('toggle', { sessionId: sessionId })
              : op('current').then(function (payload) {
                  if (!payload.sessionId) throw new Error('取不到当前会话');
                  setId(payload.sessionId);
                  return op('toggle', { sessionId: payload.sessionId });
                });
            request.then(function (payload) {
              setData(function (prev) { return { defaultEnabled: payload.state ? payload.state.defaultEnabled : (prev ? prev.defaultEnabled : false), session: payload.session || null }; });
              setError('');
            }).catch(function (err) {
              setError(String(err && err.message ? err.message : err));
            }).then(function () { setBusy(false); });
          }

          var current = data && data.session ? data.session : null;
          var enabled = current ? current.enabled !== false : false;
          var label = error ? '通知离线' : (enabled ? '推送开' : '推送关');
          var tooltip = error
            ? ('控制路由不可达：' + error)
            : ((enabled ? '关闭' : '开启') + '本会话的推送' + (current && current.title ? ('\n会话：' + current.title) : '') + (sessionId ? ('\nID：' + sessionId) : ''));

          return h('button', {
            type: 'button',
            title: tooltip,
            disabled: !!error || busy,
            onClick: toggle,
            style: Object.assign({}, BTN, { opacity: error ? 0.55 : 1, cursor: error ? 'default' : 'pointer' })
          },
            h('span', { style: Object.assign({}, DOT, { background: error ? '#ef4444' : (enabled ? '#10b981' : 'rgba(127,127,127,0.6)') }) }),
            h('span', null, '🔔 ' + label)
          );
        }

        /* ── 设置页：推送服务配置 ─────────────────────────────────────── */
        var FIELDS = {
          'wecom-robot': [
            { key: 'wecomKey', label: '群机器人 key', placeholder: 'Webhook 里 key= 后面那串', secret: true, required: true }
          ],
          'wecom-app': [
            { key: 'wecomCorpId', label: '企业 ID (CorpID)', placeholder: 'wwxxxxxxxx', required: true },
            { key: 'wecomSecret', label: '应用 Secret', secret: true, required: true },
            { key: 'wecomAgentId', label: 'AgentId', placeholder: '1000002', required: true },
            { key: 'wecomToUser', label: '接收人 UserID', placeholder: '@all 或 user1|user2' }
          ],
          'dingtalk': [
            { key: 'dingToken', label: '机器人 access_token', secret: true, required: true },
            { key: 'dingSecret', label: '加签 Secret（可选）', secret: true }
          ],
          'telegram': [
            { key: 'telegramToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...', secret: true, required: true },
            { key: 'telegramChatId', label: 'chat_id（群是 -100xxx）', placeholder: '-1001234567890', required: true },
            { key: 'telegramUserId', label: '你的 user id（白名单，可留空）', placeholder: '12345678' }
          ],
          'email': [
            { key: 'mailHost', label: 'SMTP 服务器', placeholder: 'smtp.example.com', required: true },
            { key: 'mailPort', label: '端口', placeholder: '465（SSL）/ 587（STARTTLS）' },
            { key: 'mailUser', label: '用户名', placeholder: 'me@example.com', required: true },
            { key: 'mailPass', label: '密码 / 授权码', secret: true, required: true },
            { key: 'mailFrom', label: '发件人（可选，默认同用户名）', placeholder: 'me@example.com' },
            { key: 'mailTo', label: '收件人（逗号分隔）', placeholder: 'a@x.com, b@y.com', required: true }
          ],
          'webhook': [
            { key: 'webhookUrl', label: 'Webhook 地址', placeholder: 'https://example.com/hook', required: true },
            { key: 'webhookAuth', label: 'Authorization 头（可选）', placeholder: 'Bearer xxx', secret: true },
            { key: 'webhookTemplate', label: 'JSON 模板（可选）', placeholder: '{"text":"{{text}}"}', multiline: true }
          ]
        };
        var MIRROR_LABELS = {
          '': '不镜像（只发主通道）',
          'wecom-robot': '企业微信群机器人（简报）',
          'dingtalk': '钉钉机器人（简报）',
          'email': '邮件（简报）'
        };
        var MIRROR_FIELDS = { 'wecom-robot': ['wecomKey'], 'dingtalk': ['dingToken'], 'email': ['mailTo'] };
        var EXTRA_FIELD_LABELS = {
          wecomKey: { label: '企微群机器人 key', placeholder: 'key= 后面那串', secret: true },
          dingToken: { label: '钉钉 access_token', secret: true },
          mailTo: { label: '收件人', placeholder: 'a@x.com' }
        };
        var PROVIDER_LABELS = {
          'wecom-robot': '企业微信群机器人（推荐）',
          'wecom-app': '企业微信应用消息（需可信 IP）',
          'dingtalk': '钉钉群机器人',
          'telegram': 'Telegram Bot',
          'email': '邮件 SMTP',
          'webhook': '自定义 Webhook'
        };

        var INPUT = {
          width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: '6px',
          border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit',
          fontFamily: 'inherit', fontSize: '12px', lineHeight: '18px'
        };
        var LBL = { display: 'block', fontSize: '11px', opacity: 0.75, marginBottom: '3px' };
        var ROWW = { marginBottom: '10px' };

        function SettingsPanel() {
          var cfgPair = react.useState({ provider: 'wecom-robot', values: {} });
          var config = cfgPair[0];
          var setConfig = cfgPair[1];
          var msgPair = react.useState('');
          var message = msgPair[0];
          var setMessage = msgPair[1];
          var busyPair = react.useState('');
          var busy = busyPair[0];
          var setBusy = busyPair[1];

          react.useEffect(function () {
            op('config').then(function (payload) {
              setConfig({ provider: payload.provider || 'wecom-robot', values: payload.values || {} });
            }).catch(function (err) { setMessage('读取配置失败：' + String(err && err.message ? err.message : err)); });
          }, []);

          function setValue(key, value) {
            setConfig(function (prev) {
              var values = Object.assign({}, prev.values);
              values[key] = value;
              return { provider: prev.provider, values: values };
            });
          }
          function pickProvider(provider) { setConfig({ provider: provider, values: config.values || {} }); }
          function save() {
            setBusy('save');
            op('save-config', { provider: config.provider, values: config.values }).then(function (payload) {
              setConfig({ provider: payload.provider || config.provider, values: payload.values || {} });
              setMessage('已保存');
            }).catch(function (err) { setMessage('保存失败：' + String(err && err.message ? err.message : err)); })
              .then(function () { setBusy(''); });
          }
          function test() {
            setBusy('test');
            setMessage('正在发送测试通知…');
            op('save-config', { provider: config.provider, values: config.values })
              .then(function () { return op('test'); })
              .then(function (payload) {
                setMessage(payload.ok ? '测试通知已发出，去手机上看看' : ('测试失败：' + payload.error));
              })
              .catch(function (err) { setMessage('测试失败：' + String(err && err.message ? err.message : err)); })
              .then(function () { setBusy(''); });
          }

          var fields = FIELDS[config.provider] || [];
          var rows = fields.map(function (field) {
            var value = config.values ? (config.values[field.key] === undefined ? '' : config.values[field.key]) : '';
            var input = field.multiline
              ? h('textarea', { key: field.key, rows: 3, style: Object.assign({}, INPUT, { resize: 'vertical' }), placeholder: field.placeholder || '', value: value, onChange: function (e) { setValue(field.key, e.target.value); } })
              : h('input', { key: field.key, type: 'text', style: INPUT, placeholder: field.placeholder || '', value: value, onChange: function (e) { setValue(field.key, e.target.value); } });
            return h('div', { key: field.key, style: ROWW },
              h('label', { style: LBL }, field.label + (field.required ? ' *' : '')),
              input
            );
          });

          return h('div', { style: { padding: '4px 2px 16px', maxWidth: '560px' } },
            h('div', { style: ROWW },
              h('label', { style: LBL }, '通知推送服务'),
              h('select', {
                style: INPUT,
                value: config.provider,
                onChange: function (e) { pickProvider(e.target.value); }
              }, Object.keys(PROVIDER_LABELS).map(function (key) {
                return h('option', { key: key, value: key }, PROVIDER_LABELS[key]);
              }))
            ),
            h('div', { style: ROWW },
              h('label', { style: LBL }, '镜像通道（同一事件再发一条简报，例如 TG 全文 + 企微简报）'),
              h('select', {
                style: INPUT,
                value: config.values.mirror || '',
                onChange: function (e) { setValue('mirror', e.target.value); }
              }, Object.keys(MIRROR_LABELS).map(function (key) {
                return h('option', { key: key, value: key }, MIRROR_LABELS[key]);
              }))
            ),
            (MIRROR_FIELDS[config.values.mirror || ''] || []).map(function (key) {
              var field = EXTRA_FIELD_LABELS[key] || { label: key };
              return h('div', { key: 'mirror-' + key, style: ROWW },
                h('label', { style: LBL }, '镜像 · ' + field.label),
                h('input', { type: 'text', style: INPUT, placeholder: field.placeholder || '', value: config.values[key] || '',
                  onChange: function (e) { setValue(key, e.target.value); } })
              );
            }),
            h('div', { style: ROWW },
              h('label', { style: LBL }, '代理地址（可选，CONNECT 隧道，如 http://127.0.0.1:7890）'),
              h('input', { type: 'text', style: INPUT, placeholder: 'http://127.0.0.1:7890', value: config.values.proxyUrl || '',
                onChange: function (e) { setValue('proxyUrl', e.target.value); } })
            ),
            rows,
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' } },
              h('button', { type: 'button', disabled: busy === 'save', onClick: save, style: BTN }, busy === 'save' ? '保存中…' : '保存'),
              h('button', { type: 'button', disabled: busy === 'test', onClick: test, style: BTN }, busy === 'test' ? '发送中…' : '发送测试'),
              h('span', { style: { fontSize: '11px', opacity: 0.8 } }, message)
            ),
            h('p', { style: { fontSize: '11px', opacity: 0.6, marginTop: '12px' } },
              '密钥显示为 *** 表示已保存，留空/*** 不会覆盖原值。配置存在 data/settings.json，不写进仓库。'
            )
          );
        }

        function apply(ctx) {
          ctx.slots.inject('conversation.session.header.actions', function () {
            return ctx.slots.register({
              name: 'conversation.session.header.actions',
              id: 'dsh-wecom-notify:toggle',
              order: 40
            }, SessionNotifyButton);
          });
          ctx.slots.inject('settings.plugins.tab', function () {
            return ctx.slots.register({
              name: 'settings.plugins.tab',
              id: 'dsh-wecom-notify:settings',
              order: 20,
              label: '通知推送'
            }, SettingsPanel);
          });
        }

        exports.name = 'dsh-wecom-notify';
        exports.inject = ['slots'];
        exports.apply = apply;
        return module.exports;
      }
    });
  } catch (err) {
    console.warn('[dsh-wecom-notify] client runtime error:', err);
  }
})();