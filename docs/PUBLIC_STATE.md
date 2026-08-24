# Termux Speech — 下游契约 `termux-os.speech-product-state.v1`

给**其它 package**（助手、IME、翻译、任何想用语音的东西）看的正式接口。
本文列出的字段与语义是冻结面；未在本文出现的一律是内部实现，随时可能改名或消失。

- Package: `github.termux-os.service.termux-speech`
- Version: **0.22.5**
- Capability: **`speech.state`**（`kind: action`）
- Schema: **`termux-os.speech-product-state.v1`**
  ⚠ 不是 `termux-os.speech-state.v1`——那个名字属于状态流的**信封**
  （`{domains, version, boot_id}`），两者结构完全不同。

---

## 0. 三句话

1. **只订阅这一份就够了。** 服务能不能用、有没有人在说话、是不是本人、
   现在识别到什么、最后一次识别到什么——五件事都在里面。
2. ⛔ **不要去调** RMS / FireRedVAD / CAM++ / ASR spool / segment 数据库 /
   `/live` 的任何调试域。它们是实现，实现会换。
3. ⭐ **每个字段只有一个权威**，就是本服务。⛔ 消费方不许自己从麦克风状态、
   页面动画、本地变量去猜——猜出来的状态迟早与事实分岔。

---

## 1. 怎么拿

```js
// 依赖写 capability id，⛔ 不写 package id（派生实例的 id 带后缀）
// "capabilities": { "requires": [{ "id": "speech.state", "required": false }] }
const state = await context.capabilities.invoke('speech.state', '');
```

也可以直接读 `GET /api/packages/<speech-id>/public`（同一份数据），
但**推荐走 capability**，理由同上。

---

## 2. 形状

```jsonc
{
  "schema": "termux-os.speech-product-state.v1",
  "change_seq": 42,                    // 单调递增；没变就是没变
  "service": {
    "ready": true,                     // 当前**核心**功能能不能工作
    "degraded": true,                  // 有东西不可用，但不一定影响核心
    "reason": "resident:no_voice_profile",   // 机器可读；人话由 UI 映射
    "features": {
      "manual":        { "ready": true,  "reason": null },
      "resident":      { "ready": false, "reason": "no_voice_profile" },
      "transcription": { "ready": true,  "reason": null },
    }
  },
  "activity": {
    "active": true,                    // ⚠ 「有人在说话」，⛔ 不是「麦克风开着」
    "source": "resident",              // resident | manual | null
    "user_state": "user",              // user | other | unknown
    "started_at": 1786...
  },
  "transcription": {
    "active": true,
    "segment_id": "1786...-a1b2c3",
    "revision": 2,
    "status": "incomplete",            // incomplete | complete | null
    "backend": "sensevoice",             // backend that produced this revision
    "provisional_text": "今天天气",     // status=incomplete 时有
    "final_text": null,                // status=complete 时有
    "started_at": 1786..., "updated_at": 1786...
  },
  "latest": {
    "latest_final_text": "上一句说定的话",
    "latest_final_at": 1786...,
    "latest_segment_id": "1786...-9f8e7d",
    "latest_record_id": null,
    "latest_final_backend": "sensevoice"
  }
}
```

---

## 3. 生命周期（⭐ 最重要的一节）

```
idle → activity.active=true → transcription.status=incomplete（可能多个 revision）
     → transcription.status=complete + latest.* 更新 → idle
```

| 时刻 | `transcription` | `latest` |
|---|---|---|
| 待机 | 全部为 `null`，`active:false` | **保留上一次的最终结果** |
| 有人说话 | `active:true`，`status:incomplete` | 不变 |
| 说完 | `status:complete`，`final_text` 有值 | **更新** |
| 回到待机 | 清空 | ⭐ **仍然保留** |

⭐ **`latest` 不会因为回到待机而清空**——那正是下游要读的东西。
⛔ 反过来，`transcription` 必须清空：让上一句的 final 继续挂在「当前」上，
消费方会把几分钟前的话当成此刻说的。

**三条硬规则**（都有回归测试）：

1. ⚠ **迟到的 revision 不回写。** ASR 会为同一段发多个版本且不保证顺序；
   旧版本盖掉新版本，页面上就是文字**倒退**。
2. ⚠ **空结果不进 `latest`。** 识别不出东西是「这一段没有产出」，
   不是「最近识别到空白」——让它进 `latest` 会冲掉使用者上一句有用的话。
3. ⛔ **重转写（回看历史）不动产品状态。** 那是他在翻记录，不是他在说话。

---

## 4. 字段语义

### `service`

- `ready` 只围绕**当前产品核心功能**（说话 + 识别）。
  ⛔ 模型管理器挂了、调试 Lab 用不了、某个当前没在用的模型缺失——
  这些都**不该**让 `ready` 变 false，它们只让 `degraded` 变 true。
- `reason` 是 `feature:reason` 逗号串，**机器可读**。人话映射归 UI（§6）。

### `activity`

- `active` = **有人在说话**。⚠ 与「麦克风在录」无关：麦克风可以常驻而没人说话。
- `source`：`resident`（常驻助手链）/ `manual`（手动语音输入）/ `null`。
  ⛔ 产品层枚举，不暴露内部模块名或文件名。
- `user_state`：只有常驻链做声纹判定，所以手动链恒为 `unknown`。
  ⚠ `unknown` 是**带内取值**，不是「出错了」——⛔ 手动路径不假装做过声纹判断。

### `transcription`

`status` 与 ASR 内部的 `segment_status` 同名同义，⛔ 不另造词。
`incomplete` 会被后续 revision 改写；`complete` 是这一段的最终样子。
`backend` 是产生这一版文字的 backend，不能从当前设置倒推；切换期间仍以结果实际运行的 backend 为准。

---

## 5. 两个消费方示例

**IME / 翻译**：`provisional_text` 做预览，`final_text` 做提交。

```js
if (s.transcription.status === 'incomplete') ime.preview(s.transcription.provisional_text);
if (s.transcription.status === 'complete' && s.transcription.final_text) {
  ime.commit(s.transcription.final_text);
}
```

⚠ 用 `segment_id` + `revision` 做幂等：同一段可能被投递多次。

---

## 6. 人话映射归 UI

本状态里**没有中文**，全是机器可读的枚举——因为下游可能是另一种语言的界面。
展示时自己映射，例如：

| 值 | 界面上说 |
|---|---|
| `user_state=user` | 检测到你的声音 |
| `user_state=other` | 检测到其他人的声音 |
| `status=incomplete` | 直接显示临时文字，⛔ 不显示 "incomplete" |
| `manager_unreachable` | 模型管理暂不可用 |

---

## 7. 已知边界

1. `latest_record_id` 目前恒为 `null`（记录组的稳定 id 尚未接进来）。
2. 本状态**不复制**完整历史。要历史请用 `speech.transcript` feed。
3. 服务不可达时消费方拿不到任何东西——⭐ 请把 `speech.state` 写成
   `required: false`，并在拿不到时降级，⛔ 不要把语音不可用变成你自己不可用。
