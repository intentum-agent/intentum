# intentum brand assets

The mark is a 60° chevron whose two arms meet at one point. The chevron is the
terminal prompt, where intent enters the system; the point is what that intent is
aimed at. Two independently made parts, joined where the goal sits.

## Files

| File | Use |
| --- | --- |
| `intentum-mark.svg` | Mark on light grounds (ink arms, signal-red point). |
| `intentum-mark-dark.svg` | Mark on dark grounds (paper arms, lifted red point). |
| `intentum-mark-mono.svg` | Single-colour mark, inherits `currentColor`. For UI chrome and print. |
| `intentum-tile.svg` | Rounded ink tile with the mark. GitHub org/repo avatar, app icon, npm, social. |
| `intentum-tile-paper.svg` | Paper tile variant for dark surfaces that need a light icon. |
| `intentum-tile-square.svg` | Un-rounded tile for platforms that apply their own mask. |
| `favicon.svg` | Tile with a larger mark for 16–32 px rendering. |
| `intentum-wordmark.svg`, `-dark`, `-mono` | Wordmark alone. The point moves to the `i`. |
| `intentum-logo.svg`, `-dark`, `-mono` | Horizontal lockup, mark + wordmark. The default logo. |
| `intentum-logo-stacked.svg`, `-dark` | Stacked lockup for square-ish spaces. |
| `png/` | Raster exports: tile 128–1024 (rounded and `-square`), favicon 16–64, mark 512, lockups 1200–2400 wide. |
| `ascii/` | Terminal versions in two sizes: `logo-*.txt` (mark), `text-*.txt` (wordmark), `banner-*.txt` (lockup). See [ASCII](#ascii). |

All SVGs carry a `viewBox` and scale freely. The `-mono` files set `fill="currentColor"`
so they take the surrounding text colour.

## Colour

| Token | Light grounds | Dark grounds |
| --- | --- | --- |
| Ink | `#131313` | — |
| Paper | — | `#F4F4F2` |
| Signal | `#E8302A` | `#FF5148` |

Signal red is used for the point and nothing else. It never fills a large area and it
never colours the arms or the letters.

## Rules

- Clear space around any version equals the diameter of the point.
- Minimum sizes: mark 16 px, tile 16 px, horizontal lockup 96 px wide, wordmark 72 px wide.
- In lockups the mark is as tall as the wordmark: it sits on the baseline and its top
  meets the top of the `i` dot. Use the shipped lockup files rather than re-assembling
  mark and wordmark.
- Exactly one red point per logo. The lockup carries it on the mark; the standalone
  wordmark carries it on the `i`.
- Do not rotate, outline, add gradients or shadows, change the 60° angle, move the
  point, or set the wordmark in another typeface.
- In terminals use the glyph `⋗` (U+22D7 GREATER-THAN WITH DOT). Where the font lacks
  it, use `>•`. For banners use the ASCII lockup below.

## ASCII

Two sizes of terminal lockup, each split into three files so a TUI can colour the mark
and the wordmark independently or drop the wordmark on narrow terminals.

| File | Size | Content |
| --- | --- | --- |
| `ascii/logo-big.txt` | 34 × 18 | Mark. Arms in `#`, point in `@`. |
| `ascii/text-big.txt` | 76 × 8 | Wordmark, figlet "Big Money" style in `$`. |
| `ascii/banner-big.txt` | 113 × 18 | Mark + wordmark, wordmark vertically centred, 3-column gap. |
| `ascii/logo-small.txt` | 12 × 6 | Mark. Arms in `#`, point in `o`. |
| `ascii/text-small.txt` | 44 × 5 | Wordmark, figlet "Standard" style. |
| `ascii/banner-small.txt` | 58 × 6 | Mark + wordmark, 2-column gap. |

Small banner:

```text
####            _       _             _
#######        (_)_ __ | |_ ___ _ __ | |_ _   _ _ __ ___
    #####ooo   | | '_ \| __/ _ \ '_ \| __| | | | '_ ` _ \
    #####ooo   | | | | | ||  __/ | | | |_| |_| | | | | | |
#######        |_|_| |_|\__\___|_| |_|\__|\__,_|_| |_| |_|
####
```

Big banner:

```text
###
#######
##########
##############
#################
   ##################                $$\            $$\                          $$\
      ################## @@@@@@      \__|           $$ |                         $$ |
          #############@@@@@@@@@@    $$\ $$$$$$$\ $$$$$$\    $$$$$$\  $$$$$$$\ $$$$$$\   $$\   $$\ $$$$$$\$$$$\
             #########@@@@@@@@@@@@   $$ |$$  __$$\\_$$  _|  $$  __$$\ $$  __$$\\_$$  _|  $$ |  $$ |$$  _$$  _$$\
             #########@@@@@@@@@@@@   $$ |$$ |  $$ | $$ |    $$$$$$$$ |$$ |  $$ | $$ |    $$ |  $$ |$$ / $$ / $$ |
          #############@@@@@@@@@@    $$ |$$ |  $$ | $$ |$$\ $$   ____|$$ |  $$ | $$ |$$\ $$ |  $$ |$$ | $$ | $$ |
      ################## @@@@@@      $$ |$$ |  $$ | \$$$$  |\$$$$$$$\ $$ |  $$ | \$$$$  |\$$$$$$  |$$ | $$ | $$ |
   ##################                \__|\__|  \__|  \____/  \_______|\__|  \__|  \____/  \______/ \__| \__| \__|
#################
##############
##########
#######
###
```

The point is every `@` (big) or `o` (small) cell in the mark. In a colour terminal render
those cells in Signal red (ANSI 31, or the hex above where truecolor is available) and
everything else in the default foreground. Never colour the wordmark; the rule of exactly
one red point holds here too.

Rules for the ASCII versions:

- Use only in a monospace context: CLI banners, `--version`, the first frame of the TUI,
  READMEs rendered in code blocks. Never as an image.
- Pick by `process.stdout.columns`: 113 or wider shows `banner-big`, 58 to 112 shows
  `banner-small`, 21 to 57 shows `logo-small` with plain `intentum` to its right,
  12 to 20 shows the small mark without a wordmark, and below 12 falls back to
  `⋗ intentum`. When the width is unknown assume 80. These boundaries match the
  shipped files' measured maximum line widths, so selecting a layout never causes
  avoidable terminal wrapping.
- The files are plain 7-bit ASCII with trailing whitespace stripped and no ANSI codes.
  Colour is applied by the renderer, so the same file works on any terminal.
- Do not restyle the wordmark in another figlet font and do not redraw the mark by hand.
  Edit the `logo-*` / `text-*` sources and rebuild the banners by joining them
  side-by-side with the wordmark vertically centred.

## Regenerating

Every SVG comes from `generate.mjs` (arm width, angle, point ratio, wordmark stroke).
Change the numbers there and re-run rather than hand-editing the SVGs, so every variant
stays consistent:

```
node brand/generate.mjs brand
```

PNGs are rasterised from the SVGs; regenerate them after any change.
