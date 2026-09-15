<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, TransitionGroup, watch } from 'vue'
import { checklistRowKey, type ChecklistTreeRow } from './map-tree'

const props = defineProps<{ rows: ChecklistTreeRow[]; scrollContainer: HTMLElement | null }>()
const root = ref<HTMLElement | null>(null)
const virtual = computed(() => props.rows.length > 200)
const measured = new Map<string, number>()
const measurementRevision = ref(0)
const viewportTop = ref(0)
const viewportHeight = ref(800)
const offsets = computed(() => {
  void measurementRevision.value
  const result = [0]
  for (const row of props.rows) result.push(result[result.length - 1] + (measured.get(checklistRowKey(row)) ?? 49))
  return result
})
function indexAt(offset: number): number {
  let low = 0
  let high = props.rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (offsets.value[middle + 1] <= offset) low = middle + 1
    else high = middle
  }
  return Math.min(low, Math.max(0, props.rows.length - 1))
}
const range = computed(() => virtual.value
  ? { start: indexAt(Math.max(0, viewportTop.value - 600)),
      end: Math.min(props.rows.length, indexAt(viewportTop.value + viewportHeight.value + 600) + 1) }
  : { start: 0, end: props.rows.length })
const visible = computed(() => props.rows.slice(range.value.start, range.value.end))
let observer: ResizeObserver | null = null
let frame = 0
let observedContainer: HTMLElement | null = null
function updateViewport(): void {
  frame = 0
  if (!root.value || !props.scrollContainer || !virtual.value) return
  const containerRect = props.scrollContainer.getBoundingClientRect()
  viewportTop.value = Math.max(0, containerRect.top - root.value.getBoundingClientRect().top)
  viewportHeight.value = props.scrollContainer.clientHeight
}
function scheduleViewport(): void {
  if (!frame) frame = requestAnimationFrame(updateViewport)
}
function observeRows(): void {
  observer?.disconnect()
  if (!virtual.value) return
  if (root.value) observer?.observe(root.value)
  if (props.scrollContainer) observer?.observe(props.scrollContainer)
  root.value?.querySelectorAll<HTMLElement>('.checklist-row-shell').forEach((element) => observer?.observe(element))
}
watch(() => props.scrollContainer, (container) => {
  observedContainer?.removeEventListener('scroll', scheduleViewport)
  observedContainer = container
  container?.addEventListener('scroll', scheduleViewport, { passive: true })
  scheduleViewport()
})
watch(() => props.rows, () => {
  const liveIds = new Set(props.rows.map(checklistRowKey))
  for (const key of measured.keys()) if (!liveIds.has(key)) measured.delete(key)
  scheduleViewport()
}, { flush: 'post' })
watch(visible, () => { void nextTick(observeRows) }, { flush: 'post' })
onMounted(() => {
  observer = new ResizeObserver((entries) => {
    let changed = false
    for (const entry of entries) {
      const element = entry.target as HTMLElement
      const id = element.dataset.rowId
      if (!id) continue
      const height = element.getBoundingClientRect().height
      if (height > 0 && measured.get(id) !== height) { measured.set(id, height); changed = true }
    }
    if (changed) measurementRevision.value++
    scheduleViewport()
  })
  observedContainer = props.scrollContainer
  observedContainer?.addEventListener('scroll', scheduleViewport, { passive: true })
  window.addEventListener('resize', scheduleViewport)
  updateViewport()
  observeRows()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  observedContainer?.removeEventListener('scroll', scheduleViewport)
  window.removeEventListener('resize', scheduleViewport)
  cancelAnimationFrame(frame)
})

// Tab across a virtual boundary must reach the next item, not skip the rest
// of the catalog simply because those buttons are currently off screen.
async function onKeydown(event: KeyboardEvent): Promise<void> {
  if (!virtual.value || event.key !== 'Tab' || !(event.target instanceof HTMLElement)) return
  const shell = event.target.closest<HTMLElement>('.checklist-row-shell')
  if (!shell) return
  const buttons = [...shell.querySelectorAll<HTMLElement>('button:not(:disabled)')]
  const index = Number(shell.dataset.rowIndex)
  const direction = event.shiftKey ? -1 : 1
  const nextIndex = index + direction
  if (event.target !== buttons[event.shiftKey ? 0 : buttons.length - 1] || nextIndex < 0 || nextIndex >= props.rows.length) return
  if (nextIndex >= range.value.start && nextIndex < range.value.end) return
  event.preventDefault()
  props.scrollContainer?.scrollBy({ top: offsets.value[nextIndex] - viewportTop.value, behavior: 'instant' })
  updateViewport()
  await nextTick()
  const nextButtons = root.value?.querySelector(`[data-row-index="${nextIndex}"]`)?.querySelectorAll<HTMLElement>('button:not(:disabled)')
  nextButtons?.[event.shiftKey ? nextButtons.length - 1 : 0]?.focus()
}
</script>

<template>
  <div ref="root" @keydown="onKeydown">
    <component :is="virtual ? 'div' : TransitionGroup" name="checklist-flow" tag="div" class="item-list-column" role="list">
      <div v-if="virtual" key="top-space" aria-hidden="true" :style="{ height: `${offsets[range.start]}px` }"></div>
      <div v-for="(row, offset) in visible" :key="checklistRowKey(row)" class="checklist-row-shell"
        :data-row-id="checklistRowKey(row)" :data-row-index="range.start + offset" role="listitem"
        :aria-posinset="range.start + offset + 1" :aria-setsize="rows.length">
        <slot :row="row"></slot>
      </div>
      <div v-if="virtual" key="bottom-space" aria-hidden="true" :style="{ height: `${offsets[rows.length] - offsets[range.end]}px` }"></div>
    </component>
  </div>
</template>
