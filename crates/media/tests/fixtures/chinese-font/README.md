# Chinese font export fixture

`VibeCSTestChinese.ttf` is a 3,208-byte, regular-weight subset of Noto Sans SC.
It contains the characters in `中文高光 · NiKo`, including spaces. It is used
only by the native Project export acceptance test and is not a product font.
The test writes it to its temporary import directory; no installed OS font or
network connection is required during testing.

Source: [Google Fonts Noto Sans SC](https://github.com/google/fonts/tree/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc),
`NotoSansSC[wght].ttf`, revision `a85815a42757630ce188fdad368c2dfc444d4773`.
The original copyright and SIL Open Font License are in [OFL.txt](OFL.txt).
The subset is renamed `VibeCSTestChinese`; it does not use the reserved name
`Source`.

SHA-256:

- Source TTF: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`
- Test TTF: `7d591b80485922f1d307d343a32a58b20818ada169b237085231f6995ce43fc9`

To regenerate, download the pinned source TTF and run:

```powershell
uv run --with fonttools==4.60.1 python crates/media/tests/fixtures/chinese-font/subset.py PATH_TO_SOURCE_TTF
```

The script subsets first, instantiates weight 400, preserves license metadata,
renames the family, and verifies character coverage. Python/fonttools are not
dependencies of the Rust test.
