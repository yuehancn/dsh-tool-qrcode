# dsh-tool-qrcode

> **在 dsh 里直接把二维码生成出来** —— 先算清楚这串字要多大一个码、什么纠错等级、
> 打印到几厘米才能扫得动，再出图；也能把拿到的二维码图读回文本。

给 **DeepSeek Harness** 用的自建工具插件：**内置一个从零实现的 QR 编码器**，
不装任何东西就能出 SVG。

> **Compatibility**: built and tested against dsh `0.2.0-rc.2` (preview).
> The `apply(ctx)` plugin spec is stable; verify against your own dsh version if newer.

---

## 一行安装

```bash
dsh plugin --profile desktop add github:yuehancn/dsh-tool-qrcode
```

**支持的 profile**：`desktop`（桌面版）/ `web`（Web 版）。装完重启 dsh 即可用。

---

## 为什么需要它

「帮我生成一个二维码」听起来是一句话的事，但真正会出问题的地方在**出图之前**：

- 这串 URL 到底要塞进版本几的码？版本 1 是 21×21，版本 40 是 177×177 —— 差 70 倍。
- 纠错等级选 L 还是 H？选 H 更抗污损，但同样的字会撑大整整一个版本。
- 印出来多大才能扫得动？21 个模块印成 2 厘米，手机根本对不上焦。

这个插件把「出图」和「算清楚」分开：

```
qrcode_plan(text="https://...")  →  byte 模式 / 版本 3 / 纠错 L / 还剩 12 bit 余量
qrcode_make(text="https://...")  →  29×29 的 SVG，无外部依赖
```

**关键设计**：`qrcode_plan` 是**独立的工具**，不是 `qrcode_make` 的一个参数。
因为「能不能放下」「要不要降级」「印多大」是**决策**，而生成是**执行** ——
先看清楚再动手，比生成失败再回头猜要省事得多。

---

## 四个工具

### `qrcode_status`
报这里有哪些能力：内置 SVG 编码器**永远可用**（不依赖任何外部程序）；
另外告诉你有没有配外部编码器（出 PNG 用）和解码器（读码用）。
**长任务前先问一句**，避免等到出错才发现没配 `qrencode`。

### `qrcode_plan(text, level?)`
**只算不画**。返回：自动判定的编码模式（numeric / alphanumeric / byte / kanji）、
放得下的最小版本、纠错等级、容量余量，以及「如果不行该怎么办」的补救建议。

模式是自动挑的，而且**这个选择会显著影响体积**：纯数字 36 位能塞进版本 1，
同样的**字节**模式只能塞 17 位。所以它会把判定结果明确告诉你。

### `qrcode_make(text, level?, ...)`
出图。默认 **SVG**，内置编码器，**零依赖**。

| 参数 | 说明 |
|---|---|
| `level` | `l` / `m` / `q` / `h`，默认 `l`。放不下会自动降级并**在 `notes` 里说明** |
| `outputName` | 文件名，默认按内容生成 |
| `scale` | 每个模块几像素，默认 8 |
| `quietZone` | 静区模块数，默认 4（**标准要求**，别改小） |
| `lightColor` / `darkColor` | 前后景色，默认 `#ffffff` / `#000000` |
| `margin` | 是否留白 |

要 PNG/JPEG 就得配外部编码器 —— 插件会**明确报错并告诉你怎么配**，
而不是默默给你一个改名的 SVG。

### `qrcode_read(path, format?)`
把二维码图读回文本。需要配解码器（`zbarimg`、`zxing` 之类）。

读不到的时候不会只丢一句「失败」—— 它会**列出可能的原因**：静区被裁掉了、
图太小或糊了、颜色反了（浅色码深色底）。因为模型看不到图，
这些提示才是它下次能改对的前提。

---

## 配置

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: tool-qrcode
  config:
    outputDir: C:/Users/you/Pictures/qrcode-output
    encodeCommand: qrencode            # 可选：要出 PNG 才需要
    encodeArgs: ["-o", "{output}", "-t", "PNG", "-l", "{level}", "{text}"]
    decodeCommand: zbarimg             # 可选：要读码才需要
    decodeArgs: ["--raw", "-q", "{input}"]
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `outputDir` | `qrcode-output` | 产物目录 |
| `encodeCommand` | `""` | 外部编码器，空 = 只出 SVG |
| `encodeArgs` | qrencode 的模板 | 支持 `{output}` `{text}` `{level}` `{input}` 占位符 |
| `decodeCommand` | `""` | 外部解码器，空 = `qrcode_read` 不可用 |
| `decodeArgs` | `["--raw", "-q", "{input}"]` | 支持 `{input}` 占位符 |
| `scale` | `8` | 默认每模块像素 |
| `quietZone` | `4` | 默认静区模块数 |
| `timeoutMs` | `60000` | 单次调用预算 |
| `lightColor` / `darkColor` | `#ffffff` / `#000000` | 默认配色 |
| `status`/`plan`/`make`/`read` | `true` | 按需关掉某个工具 |

**注意编码器不是可执行文件的情况**：`encodeCommand` 支持写成解释器 + 脚本，
比如 `encodeCommand: node` + `encodeArgs: ["C:/path/qr.mjs", "encode", "{output}", "{level}", "{text}"]`。
`qrcode_status` 的探测会**穿过解释器去问脚本本身的版本**，而不是报 Node 的版本号。

---

## 安全说明

- 只用 `spawn(command, argsArray)` 调用 —— **不拼 shell 字符串**，
  路径里有空格、引号、中文都不会出事。
- **内置编码器不出网、不写盘以外的地方**，SVG 就是一个纯文本文件。
- 覆盖已存在的产物会被拒绝，除非文件名不冲突。
- 不会主动上传任何内容，也不联网。

---

## 实现说明：为什么敢说它是标准实现

QR 码是 **ISO/IEC 18004** 标准，一个 bit 都不能错 —— 写错的话产出的图
「看起来像个二维码」但扫不出来。所以这里没有走捷径，四个最难的坑都踩过：

1. **格式信息里的纠错等级编码顺序反直觉**。容量表是按 `L/M/Q/H` 排的，
   但格式信息那 2 bit 是 `M=00, L=01, H=10, Q=11` —— **不是同一个顺序**。
   一开始按容量表的顺序写，8 个符号全部扫不出来。

2. **定位图形必须在定时图形之前画**。定位校正图形的跳过判断会看它自己的
   中心格，而定时图形正好穿过那些中心，先画定时就会把定位中心标记成
   「已占用」，定位图形被静默跳过。

3. **版本 ≥ 7 要写版本信息块**，且两个副本的坐标方向是转置关系。
   只保留位置不填内容的话，小版本一切正常、大版本全错。

4. **掩码要按 4 条罚分规则选**，选错的话图能看但扫不稳。

验证方式：`_test/verify-qr.py` 用**两条独立路径**校验 —— OpenCV 的
`QRCodeDetector` 解码，以及用 Python `qrcode` 库**强制成同一个掩码**后
逐模块 diff。掩码无关的对比是错的：两个都正确的编码器可能合法地选到不同掩码。

当前结果：**8/8 符号与参考实现逐模块完全一致，8/8 被 OpenCV 成功解码**
（覆盖版本 1、2、3、5、10、17，含中文多字节 payload）。

---

## 跑测试

```bash
mkdir -p node_modules/@deepseek-ai
cp -r "$HOME/.dsh/profiles/desktop/node_modules/@deepseek-ai/." node_modules/@deepseek-ai/
node _test/run-all.mjs
```

三个套件，**268 条断言全绿**（对着真实 `@deepseek-ai/dsh-tools` 跑，不 mock）：

| 套件 | 断言 | 内容 |
|---|---|---|
| `test-logic.mjs` | 70 | 编码模式判定、容量边界（**36 位数字刚好塞满版本 1，37 位溢出**）、纠错等级选择、Reed-Solomon、位流组装、打印尺寸、`Config` 默认值与覆盖 |
| `test-integration.mjs` | 53 | 引擎探测（含**解释器 + 脚本**形态）、外部编解码往返、静默/失败引擎、解码失败提示、格式嗅探、颜色与缩放渲染 |
| `test-e2e.mjs` | 145 | 8 个真实 payload 出图 → SVG 结构校验 → **从 path 反推模块网格** → 三个定位图形位置核对 → 跨缩放一致性 → 超长 payload 拒绝 → 等级不可达时降级并说明 |

再跑一次独立校验（需要 Python + `qrcode` + `opencv-python`）：

```bash
python _test/verify-qr.py _test/samples
```

`test-e2e.mjs` 会把样本写到 `_test/samples/`，正是给这个脚本消费的 ——
所以 e2e 是「自己验自己」，而这个脚本是「**别人**验自己」。

---

## 许可

MIT