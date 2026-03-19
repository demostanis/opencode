import { Terminal, type IBufferLine } from "@xterm/headless"

export interface CellStyle {
  fg: string | undefined
  bg: string | undefined
  bold: boolean
  italic: boolean
  dim: boolean
  underline: boolean
  inverse: boolean
  strikethrough: boolean
  cursor?: boolean
}

export interface StyledLine {
  segments: { text: string; style: CellStyle }[]
  cursorX: number | undefined // -1 if not on this line
}

export function createVirtual(cols: number, rows: number) {
  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    scrollback: 10000,
  })

  let dirty = true

  function write(data: string): Promise<void> {
    return new Promise((resolve) => {
      term.write(data, () => {
        dirty = true
        resolve()
      })
    })
  }

  function resize(cols: number, rows: number) {
    term.resize(cols, rows)
    dirty = true
  }

  function isDirty() {
    return dirty
  }

  function clearDirty() {
    dirty = false
  }

  function getBuffer(): StyledLine[] {
    const buffer = term.buffer.active
    const lines: StyledLine[] = []
    const cursorX = buffer.cursorX
    const viewportY = buffer.viewportY
    // cursorY is relative to viewport, convert to absolute buffer position
    const cursorAbsY = viewportY + buffer.cursorY

    // Find the last line with actual content (excluding whitespace-only lines)
    let lastContentLine = -1
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)
      if (!line) continue
      const text = line.translateToString(true)
      if (text.length > 0) {
        lastContentLine = y
      }
    }

    // Always include cursor line
    const lastLine = Math.max(lastContentLine, cursorAbsY)

    for (let y = 0; y <= lastLine; y++) {
      const line = buffer.getLine(y)
      if (!line) continue
      lines.push(parseLine(line, y === cursorAbsY ? cursorX : -1))
    }

    return lines
  }

  function dispose() {
    term.dispose()
  }

  return { write, resize, isDirty, clearDirty, getBuffer, dispose, term }
}

function parseLine(line: IBufferLine, cursorX: number): StyledLine {
  const segments: StyledLine["segments"] = []
  let currentText = ""
  let currentStyle: CellStyle | undefined
  const lineLen = line.length
  let hasContent = false

  for (let x = 0; x < lineLen; x++) {
    const cell = line.getCell(x)
    if (!cell) continue

    let chars = cell.getChars()
    // Track if we have actual non-space content
    if (chars !== "") {
      hasContent = true
    }
    // Convert empty cells to spaces (for tabs)
    if (chars === "") {
      chars = " "
    }
    const style = getCellStyle(cell)

    // Render cursor as inverse character
    if (cursorX >= 0 && x === cursorX) {
      if (currentText && currentStyle) {
        segments.push({ text: currentText, style: currentStyle })
      }
      segments.push({ text: chars, style: { ...style, cursor: true } })
      currentText = ""
      currentStyle = style
      continue
    }

    if (currentStyle && stylesEqual(currentStyle, style)) {
      currentText += chars
    } else {
      if (currentText && currentStyle) {
        segments.push({ text: currentText, style: currentStyle })
      }
      currentText = chars
      currentStyle = style
    }
  }

  // Handle cursor at end of line or beyond
  if (cursorX >= lineLen) {
    if (currentText && currentStyle) {
      segments.push({ text: currentText, style: currentStyle })
    }
    segments.push({
      text: " ",
      style: {
        fg: undefined,
        bg: undefined,
        bold: false,
        italic: false,
        dim: false,
        underline: false,
        inverse: false,
        strikethrough: false,
        cursor: true,
      },
    })
  } else if (currentText && currentStyle) {
    segments.push({ text: currentText, style: currentStyle })
  }

  // Trim trailing spaces from the last segment
  if (segments.length > 0) {
    const last = segments[segments.length - 1]!
    const trimmed = last.text.trimEnd()
    if (trimmed.length > 0) {
      last.text = trimmed
    } else if (!last.style.cursor) {
      // Remove the segment if it's all spaces and not a cursor
      segments.pop()
    }
  }

  return { segments, cursorX: cursorX >= 0 ? cursorX : -1 }
}

function getCellStyle(cell: {
  getFgColor(): number
  getBgColor(): number
  isFgRGB(): boolean
  isBgRGB(): boolean
  isFgPalette(): boolean
  isBgPalette(): boolean
  isFgDefault(): boolean
  isBgDefault(): boolean
  isBold(): number
  isItalic(): number
  isDim(): number
  isUnderline(): number
  isInverse(): number
  isStrikethrough(): number
}): CellStyle {
  let fg: string | undefined
  let bg: string | undefined

  if (cell.isFgRGB()) {
    const c = cell.getFgColor()
    fg = `#${((c >> 16) & 0xff).toString(16).padStart(2, "0")}${((c >> 8) & 0xff).toString(16).padStart(2, "0")}${(c & 0xff).toString(16).padStart(2, "0")}`
  } else if (cell.isFgPalette()) {
    fg = paletteToHex(cell.getFgColor())
  }

  if (cell.isBgRGB()) {
    const c = cell.getBgColor()
    bg = `#${((c >> 16) & 0xff).toString(16).padStart(2, "0")}${((c >> 8) & 0xff).toString(16).padStart(2, "0")}${(c & 0xff).toString(16).padStart(2, "0")}`
  } else if (cell.isBgPalette()) {
    bg = paletteToHex(cell.getBgColor())
  }

  return {
    fg,
    bg,
    bold: !!cell.isBold(),
    italic: !!cell.isItalic(),
    dim: !!cell.isDim(),
    underline: !!cell.isUnderline(),
    inverse: !!cell.isInverse(),
    strikethrough: !!cell.isStrikethrough(),
  }
}

function stylesEqual(a: CellStyle, b: CellStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.dim === b.dim &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.strikethrough === b.strikethrough
  )
}

function paletteToHex(index: number): string {
  // Standard 16 colors
  const palette = [
    "#000000",
    "#cd0000",
    "#00cd00",
    "#cdcd00",
    "#0000ee",
    "#cd00cd",
    "#00cdcd",
    "#e5e5e5",
    "#7f7f7f",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#5c5cff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ]
  if (index < 16) return palette[index]

  // 6x6x6 color cube (16-231)
  if (index < 232) {
    const i = index - 16
    const r = Math.floor(i / 36)
    const g = Math.floor((i % 36) / 6)
    const b = i % 6
    const toVal = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    return `#${toVal(r).toString(16).padStart(2, "0")}${toVal(g).toString(16).padStart(2, "0")}${toVal(b).toString(16).padStart(2, "0")}`
  }

  // Grayscale ramp (232-255)
  const gray = 8 + (index - 232) * 10
  return `#${gray.toString(16).padStart(2, "0").repeat(3)}`
}
