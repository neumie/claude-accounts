import { render } from 'solid-js/web'
import { Popup } from './Popup.tsx'

const root = document.getElementById('root')
if (root) render(() => <Popup />, root)
