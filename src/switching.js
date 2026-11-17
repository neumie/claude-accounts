// Parking page fallback: normally the extension brings this tab back within seconds.
// Reached with Back, or left here because the switch was cut short → go to claude.ai.
const nav = performance.getEntriesByType('navigation')[0]
if (nav && nav.type === 'back_forward') location.replace('https://claude.ai/new')
else setTimeout(() => location.replace('https://claude.ai/new'), 45_000)
