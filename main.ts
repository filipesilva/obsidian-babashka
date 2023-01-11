import { App, Editor, EditorPosition, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { exec } from 'child_process';

const DEFAULT_OUTPUT_LIMIT = 1000;

interface Codeblock {
	lang: string,
	code: string,
	insertPos: EditorPosition,
}

function getCodeblockForCursor(editor: Editor): Codeblock | null {
	const src = editor.getValue();
	const cursor = editor.getCursor();
	const cljRe = /^```(clojure|clojurescript)$\s([\s\S]*?)^```$/gmd;
	const cljCodeblocks = Array.from(src.matchAll(cljRe));
	const cursorOffset = editor.posToOffset(cursor);
	const insideMatch = offset => match => match.indices[0][0] <= offset && offset <= match.indices[0][1];
	const match = cljCodeblocks.find(insideMatch(cursorOffset));

	if (match) {
		return {
			lang: match[1],
			code: match[2],
			insertPos: editor.offsetToPos(match.indices[2][1]),
		}
	} else {
		return null;
	}
}

function validateSettingsForCodeblock(codeblock: Codeblock, settings: PluginSettings) {
	const { lang } = codeblock;
	const { bbPath, nbbPath, nodePath } = settings;

	if (lang == 'clojure' && !bbPath) {
		new Notice('Please set Babashka path in settings');
		return false;
	}

	if (lang == 'clojurescript' && (!nbbPath || !nodePath)) {
		new Notice('Please set both Node Babashka and Node paths in settings');
		return false;
	}

	return true;
}

function capCharsAt(str: string, maxChars: number) {
	if (str.length > maxChars) {
		return str.substring(0, maxChars) + `\n... and ${str.length - maxChars} more chars}`;
	} else {
		return str;
	}
}

function executeCodeblock(codeblock: Codeblock, vaultPath: string, editor: Editor, settings: PluginSettings) {
	const { lang, code, insertPos } = codeblock;
	const { bbPath, nbbPath, nodePath, bbDir, limitOutput } = settings;

	if (validateSettingsForCodeblock(codeblock, settings)) {
		const bin = lang == 'clojure' ? bbPath : `${nodePath} ${nbbPath}`;
		const ext = lang == 'clojure' ? 'clj' : 'cljs';
		const pluginCwd = `${vaultPath}/${bbDir}`;

		// TODO: add magic bindings
		// https://github.com/twibiral/obsidian-execute-code#magic-commands-
		const codeShellStr = code.replaceAll("\"", "\\\"");
		const cmd = `${bin} -e "${codeShellStr}"`;

		console.debug(`babashka executing: \`${cmd}\` on ${pluginCwd}`);
		// TODO: save process for kill?
		// TODO: some max lines
		const p = exec(
			cmd,
			{ cwd: `${pluginCwd}` },
			(err, stdout, stderr) => {
				if (err) {
					const errorMsg = 'Error during execution:\n' + err;
					console.error(errorMsg)
					new Notice(errorMsg, 5000);
					return;
				}

				if (stderr) {
					const errorMsg = 'stderr during execution:\n' + stderr;
					console.error(errorMsg)
					new Notice(errorMsg, 5000);
					return;
				}

				if (stdout) {
					const cappedOutput = limitOutput ? capCharsAt(stdout, DEFAULT_OUTPUT_LIMIT) : stdout;
					const outputAsComments = cappedOutput.trim().replaceAll(/^/gm, ';; ');
					editor.replaceRange(`\n${outputAsComments}\n`, insertPos, insertPos);

				}
				console.debug(`babashka stdout:\n${stdout}`);
				console.debug(`babashka stderr:\n${stderr}`);
			});
	}
}

interface PluginSettings {
	bbDir: string,
	bbPath: string,
	nbbPath: string,
	nodePath: string,
	limitOutput: boolean,
}

const DEFAULT_SETTINGS: PluginSettings = {
	bbDir: 'babashka',
	bbPath: '',
	nbbPath: '',
	nodePath: '',
	limitOutput: true,
}

export default class BabashkaPlugin extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new SettingTab(this.app, this));

		this.addCommand({
			id: 'obsidian-babashka-execute-codeblock',
			name: 'Execute codeblock',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const codeblock = getCodeblockForCursor(editor);
				if (codeblock) {
					const vaultPath = this.app.vault.adapter.getBasePath();
					executeCodeblock(codeblock, vaultPath, editor, this.settings);
				} else {
					new Notice('No clojure(script) codeblock found');
				}
			}
		});
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SettingTab extends PluginSettingTab {
	plugin: BabashkaPlugin;

	constructor(app: App, plugin: BabashkaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	addTextSetting(name: string, desc: string, placeholder: string, k: keyof PluginSettings) {
		const { containerEl } = this;
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText(text => text
				.setPlaceholder(placeholder)
				.setValue(this.plugin.settings[k])
				.onChange(async (value) => {
					this.plugin.settings[k] = value;
					await this.plugin.saveSettings();
				}));
	}

	addToggleSetting(name: string, desc: string, k: keyof PluginSettings) {
		const { containerEl } = this;
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings[k])
				.onChange(async (value) => {
					this.plugin.settings[k] = value;
					await this.plugin.saveSettings();
				}));
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// TODO: toggle instead hardcoded to 1k
		containerEl.createEl('h2', { text: 'General' });
		this.addToggleSetting('Limit output', `Output will be truncated after ${DEFAULT_OUTPUT_LIMIT} characters.`, 'limitOutput');

		containerEl.createEl('h2', { text: 'Paths' });
		this.addTextSetting('Vault Babashka dir', 'Relative path to babashka dir from vault root. Babashka will be run from this dir. You can put bb.edn, nbb.edn, and package.json files there to use dependencies.', '', 'bbDir');
		this.addTextSetting('Babashka path', 'Absolute path to babashka.', 'run `which bb` to see it', 'bbPath');
		this.addTextSetting('Node Babashka path', 'Absolute path to nbb.', 'run `which nbb` to see it', 'nbbPath');
		this.addTextSetting('Node path', 'Absolute path to node.', 'run `which nbb` to see it', 'nodePath');
	}
}
