<template>
  <Teleport to="body">
    <div v-if="shouldRender" v-show="visible" class="app-drawer-root">
      <div class="app-drawer-mask" @click="handleMaskClick" />
      <aside class="app-drawer-panel" :style="panelStyle">
        <header class="app-drawer-header">
          <slot name="title">
            <strong>{{ title }}</strong>
          </slot>
          <button type="button" class="app-drawer-close" aria-label="关闭" @click="handleClose">×</button>
        </header>
        <div class="app-drawer-body">
          <slot />
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  visible: boolean;
  title?: string;
  width?: number | string;
  maskClosable?: boolean;
  unmountOnClose?: boolean;
}>(), {
  title: '',
  width: 280,
  maskClosable: true,
  unmountOnClose: false
});

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void;
  (event: 'close'): void;
}>();

const shouldRender = computed(() => props.visible || !props.unmountOnClose);
const panelStyle = computed(() => ({
  width: typeof props.width === 'number' ? `${props.width}px` : props.width
}));

function handleClose(): void {
  emit('update:visible', false);
  emit('close');
}

function handleMaskClick(): void {
  if (props.maskClosable) {
    handleClose();
  }
}
</script>

<style scoped>
.app-drawer-root {
  position: fixed;
  inset: 0;
  z-index: 1900;
}

.app-drawer-mask {
  position: absolute;
  inset: 0;
  background: rgba(11, 22, 20, 0.42);
  backdrop-filter: blur(4px);
}

.app-drawer-panel {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: min(86vw, 280px);
  border-right: 1px solid rgba(24, 52, 47, 0.12);
  background: rgba(252, 247, 240, 0.98);
  box-shadow: 0 18px 48px rgba(31, 49, 43, 0.16);
  display: flex;
  flex-direction: column;
}

.app-drawer-header {
  padding: 18px 16px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.app-drawer-body {
  padding: 0 16px 20px;
  overflow: auto;
}

.app-drawer-close {
  width: 34px;
  height: 34px;
  border: 1px solid rgba(24, 52, 47, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.86);
  color: #33534c;
  font-size: 20px;
  line-height: 1;
}
</style>
