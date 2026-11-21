<template>
  <div class="bg-[#161b22] border border-slate-700 rounded-xl p-4 shadow-2xl text-xs space-y-3 w-[380px]" style="--wails-draggable:no-drag;">
    <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{{ t('settings.title') }}</div>
    <div v-if="edition !== 'pc'">
      <label class="block text-slate-400 mb-1">{{ t('settings.ryuPath') }}</label>
      <div class="flex gap-1">
        <input v-model="cfg.saveDirRyujinx" :placeholder="t('settings.pathAuto')" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white font-mono focus:border-blue-500 focus:outline-none placeholder-slate-600" />
        <button @click="pickSave('ryu')" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">{{ t('buttons.browse') }}</button>
      </div>
      <div v-if="saveRyuHint" class="text-[10px] text-slate-600 mt-1" :class="saveRyuOk ? 'text-emerald-400' : ''">{{ saveRyuHint }}</div>
    </div>
    <div v-if="edition !== 'pc'">
      <label class="block text-slate-400 mb-1">{{ t('settings.edenPath') }}</label>
      <div class="flex gap-1">
        <input v-model="cfg.saveDirEden" :placeholder="t('settings.pathAuto')" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white font-mono focus:border-blue-500 focus:outline-none placeholder-slate-600" />
        <button @click="pickSave('eden')" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">{{ t('buttons.browse') }}</button>
      </div>
      <div v-if="saveEdenHint" class="text-[10px] text-slate-600 mt-1" :class="saveEdenOk ? 'text-emerald-400' : ''">{{ saveEdenHint }}</div>
    </div>
    <div v-if="edition === 'pc'">
      <label class="block text-slate-400 mb-1">{{ t('settings.pcProfile') }}</label>
      <div class="flex gap-1 items-center">
        <select v-model="cfg.profile" @focus="refreshPCProfiles" class="flex-1 min-w-0 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white text-xs focus:border-blue-500 focus:outline-none">
          <option value="auto">{{ t('settings.pcProfileAuto') }}</option>
          <option v-for="p in pcProfiles" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <button @click="openProfilesDir" class="bg-slate-700 hover:bg-slate-600 px-2.5 py-1.5 rounded text-xs shrink-0">{{ t('settings.openProfilesDir') }}</button>
      </div>
      <div class="text-[10px] text-slate-500 mt-1">{{ t('settings.pcProfileHint') }}</div>
    </div>
    <div>
      <label class="block text-slate-400 mb-1">{{ t('settings.workDir') }}</label>
      <div class="flex gap-1 items-center">
        <span class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-slate-300 font-mono text-[11px] truncate">{{ t('settings.exeDir') }}</span>
        <button @click="openLogDir" class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs">{{ t('buttons.openDir') }}</button>
      </div>
    </div>
    <div>
      <label class="flex items-center gap-2 cursor-pointer select-none py-1">
        <input v-model="cfg.tls" type="checkbox" class="accent-blue-600 w-3.5 h-3.5" />
        <span class="text-slate-300">{{ t('settings.tls') }}</span>
        <span class="text-[10px] text-amber-500/90">{{ t('settings.tlsWarn') }}</span>
      </label>
    </div>
    <div>
      <label class="flex items-center gap-2 cursor-pointer select-none py-1">
        <input v-model="cfg.autoOpenMap" type="checkbox" class="accent-blue-600 w-3.5 h-3.5" />
        <span class="text-slate-300">{{ t("settings.autoOpenMap") }}</span>
      </label>
    </div>
    <!-- 桌面后台语音导航（独立模块可插拔，全屏游戏不开网页也能播报） -->
    <div>
      <label class="block text-slate-400 mb-1">{{ t('settings.voiceNav') }}</label>
      <div class="flex gap-1.5 items-center">
        <select :value="voicePack" @change="onVoiceChange($event)" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white text-xs focus:border-blue-500 focus:outline-none">
          <option value="off">{{ t('settings.voiceOff') }}</option>
          <option value="zelda">{{ t('settings.voiceZelda') }}</option>
          <option value="yujie">{{ t('settings.voiceYujie') }}</option>
          <option value="chime">{{ t('settings.voiceChime') }}</option>
        </select>
        <button type="button" @click="testGuiVoice" class="bg-slate-700 hover:bg-slate-600 text-amber-300 px-2.5 py-1.5 rounded text-xs shrink-0">{{ t('settings.voiceTest') }}</button>
      </div>
      <div class="text-[10px] text-slate-500 mt-1">{{ t('settings.voiceHint') }}</div>
    </div>
    <!-- 界面语言（跟随系统 / 中文 / English，即时切换） -->
    <LangSelect />
    <div class="flex items-center gap-2 pt-1">
      <button class="bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded text-xs text-white" @click="doSave">{{ t('buttons.save') }}</button>
      <span v-if="savedMsg" class="text-[11px] font-mono" :class="savedMsgClass">{{ savedMsg }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import LangSelect from './LangSelect.vue'
import { cfg, edition, envDetect, pickSave, saveSettings, openLogDir, pcProfiles, refreshPCProfiles, openProfilesDir, voicePack, setGuiVoicePack, testGuiVoice } from '../composables/useCore'

const { t } = useI18n()

function onVoiceChange(e) {
  setGuiVoicePack(e.target.value)
  if (e.target.value !== 'off') testGuiVoice()
}

onMounted(() => {
  if (edition.value === 'pc') refreshPCProfiles()
})

const savedMsg = ref('')
const savedMsgClass = ref('text-emerald-400')
const saveRyuOk = computed(() => envDetect.saveRyu)
const saveEdenOk = computed(() => envDetect.saveEden)
const saveRyuHint = computed(() => {
  if (!cfg.saveDirRyujinx) return ''
  return envDetect.saveRyu ? t('settings.pathOk') : t('settings.pathBad')
})
const saveEdenHint = computed(() => {
  if (!cfg.saveDirEden) return ''
  return envDetect.saveEden ? t('settings.pathOk') : t('settings.pathBad')
})

async function doSave() {
  await saveSettings()
  savedMsg.value = t('settings.saved')
  savedMsgClass.value = 'text-emerald-400'
  setTimeout(() => { savedMsg.value = '' }, 2000)
}
</script>
