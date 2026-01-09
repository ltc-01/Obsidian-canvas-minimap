import { App, TAbstractFile, Plugin, PluginSettingTab, Setting, FileView, Keymap, Events } from 'obsidian';
import * as d3 from "d3";
import { assert } from 'console';
import { around } from 'monkey-around'; // for canvas patching
import { t } from 'i18n';

// Obsidian canvas types
interface CanvasRect{
	cx: number;
	cy: number;
	width: number;
	height: number;
	left: number;
	top: number;
	maxX: number;
	maxY: number;
	minX: number;
	minY: number;
}

class CanvasEvent extends Events {
	constructor() {
	  super();
	}
}
type CanvasEventType = "CANVAS_MOVED" | "CANVAS_DIRTY" | "CANVAS_VIEWPORT_CHANGED" | "CANVAS_TICK";
type CanvasNavigationStrategy = "PAN" | "ZOOM" | "NONE";

class Vector2 {
	x: number
	y: number
	constructor(x: number, y: number) {
		this.x = x
		this.y = y
	}
	static add(a: Vector2, b: Vector2) {
		return new Vector2(a.x + b.x, a.y + b.y)

	}
	static sub(a: Vector2, b: Vector2) {
		return new Vector2(a.x - b.x, a.y - b.y)
	}

	static len(a: Vector2) {
		return Math.sqrt(Vector2.lenSq(a))
	}

	static lenSq(a: Vector2) {
		return a.x * a.x + a.y * a.y
	}
}

class BoundingBox {
	minX: number
	minY: number
	maxX: number
	maxY: number
	constructor(min_x = 0, min_y = 0, max_x = 0, max_y = 0) {
		this.minX = min_x
		this.minY = min_y
		this.maxX = max_x
		this.maxY = max_y
	}
	static fromRect(bbox: SVGRect | undefined) {
		if (!bbox)
			return new BoundingBox()
		return new BoundingBox(bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height)
	}
	width() {
		return this.maxX - this.minX
	}
	height() {
		return this.maxY - this.minY
	}
	contains(p: Vector2) {
		return p.x >= this.minX && p.x <= this.maxX && p.y >= this.minY && p.y <= this.maxY
	}
	isValid(){
		return this.minX < this.maxX && this.minY < this.maxY	
	}
}

function clamp(x: number, min: number, max: number) {
	return Math.min(Math.max(x, min), max)
}


// Remember to rename these classes and interfaces!
type MinimapSide = 'top-right' | 'top-left' | 'bottom-left' | 'bottom-right';

interface CanvasMinimapSettings {
	width: number;
	height: number;
	margin: number;
	fontSize: number;
	fontColor: string;
	side: MinimapSide;
	enabled: boolean;
	backgroundColor: string;
	groupColor: string;
	nodeColor: string;
	hijackToolbar: boolean;
	drawActiveViewport: boolean;
	primaryNavigationStrategy: CanvasNavigationStrategy;
	secondaryNavigationStrategy: CanvasNavigationStrategy;
	positionX: number;
	positionY: number;
	minimapOpacity: number;
}

const DEFAULT_SETTINGS: CanvasMinimapSettings = {
	width: 400,
	height: 300,
	margin: 100,
	fontSize: 10,
	fontColor: 'white',
	side: 'bottom-right',
	enabled: true,
	backgroundColor: '#f3f0e9',
	groupColor: '#bdd5de55',
	nodeColor: '#c3d6d7',
	hijackToolbar: false,
	drawActiveViewport: true,
	primaryNavigationStrategy: 'ZOOM',
	secondaryNavigationStrategy: 'PAN',
	positionX: 0,
	positionY: 0,
	minimapOpacity: 1
}

export default class CanvasMinimap extends Plugin {
	settings: CanvasMinimapSettings;
	canvas_bounds: BoundingBox = new BoundingBox()
	canvas_patched: boolean = false
	canvas_event: CanvasEvent = new CanvasEvent()

	async onload() {
		await this.loadSettings();


		this.addCommand({
			id: t('reload'),
			name: t('reloadDesc'),
			checkCallback: (checking: boolean) => {

				if (this.getActiveCanvas()) {
					if (!checking) {
						this.reloadMinimap()
					}
					return true;
				}
			}
		});

		this.addCommand({
			id: t('toggle'),
			name: t('toggleDesc'),
			checkCallback: (checking: boolean) => {
				if (this.getActiveCanvas()) {
					if (!checking) {
						this.settings.enabled = !this.settings.enabled
						this.saveSettings()
					}
					return true;
				}
			}
		});

		this.addSettingTab(new CanvasMinimapSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.setupMinimap()
		})

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			this.reloadMinimap()
		}))
		this.registerEvent(this.app.workspace.on('resize', () => {
			this.reloadMinimap()
		}))

		this.registerEvent(this.app.vault.on('modify', (file: TAbstractFile) => {
			if(!this.getActiveCanvas())
				return
			const activeFile = this.app.workspace.getActiveFile()
			// check if the file is the active file
			if (activeFile && file.path === activeFile.path)
			{
				this.reloadMinimap()
			}
		}))
	}

	renderMinimap(svg: any, canvas: any) {
		const nodes: Map<string, any> = canvas.nodes
		const edges: Map<string, any> = canvas.edges

		const sidePositionOf = (node: any, side: string) => {
			const origin = new Vector2(node.x, node.y);
			const radius = new Vector2(node.width / 2, node.height / 2);
			const center = Vector2.add(origin, radius);

			if (side == "left") {
				return Vector2.sub(center, new Vector2(radius.x, 0));
			} else if (side == "right") {
				return Vector2.add(center, new Vector2(radius.x, 0));
			} else if (side == "top") {
				return Vector2.sub(center, new Vector2(0, radius.y));
			} else if (side == "bottom") {
				return Vector2.add(center, new Vector2(0, radius.y));
			}
			throw new Error(`invalid side ${side}`);
		};


		const bbox: BoundingBox = new BoundingBox();
		const groups: Map<string, any> = new Map()
		const children: Map<string, any> = new Map()
		nodes.forEach((node: any) => {
			bbox.minX = Math.min(bbox.minX, node.x);
			bbox.minY = Math.min(bbox.minY, node.y);
			bbox.maxX = Math.max(bbox.maxX, node.x + node.width);
			bbox.maxY = Math.max(bbox.maxY, node.y + node.height);
			if (node.unknownData?.type === 'group') {
				groups.set(node.id, node)
			} else {
				children.set(node.id, node)
			}
		});

		// save the canvas bounds
		this.canvas_bounds = new BoundingBox(
			bbox.minX - this.settings.margin, 
			bbox.minY - this.settings.margin, 
			bbox.maxX + this.settings.margin,
			bbox.maxY + this.settings.margin)
		
			svg.attr(
				"viewBox",
				`${this.canvas_bounds.minX} ${this.canvas_bounds.minY} ${this.canvas_bounds.width()} ${this.canvas_bounds.height()}`
			)
				.attr("preserveAspectRatio", "xMidYMid meet")
				.attr("width", this.settings.width)
				.attr("height", this.settings.height);
			
			
			let bg = svg.append('g')
				.attr('id', 'minimap_bg')
			let fg = svg.append('g')
				.attr('id', 'minimap_fg')
			

		groups.forEach((n: any) => {
			const g = fg.append('g')
			const rect = g.append("rect");

			const props = Object.entries(n);
			for (const [k, v] of props) {
				// allowed props: x, y, width, height, id
				if (k === 'x' || k === 'y' || k === 'width' || k === 'height' || k === 'id')
					rect.attr(k, v);
			}
			rect.attr("stroke", "darkblue");
			rect.attr("fill", this.settings.groupColor);
			

			const label: string = n.label
			if (label) {
				// prevent text from scaling
				const scale_x = this.settings.width / (bbox.maxX - bbox.minX)
				const scale_y = this.settings.height / (bbox.maxY - bbox.minY)
				const scale = Math.min(scale_x, scale_y)
				const font_size = this.settings.fontSize / scale
				const text = g.append("text")
				text
					.text(label)
					.attr("x", n.x)
					.attr("y", n.y)
					.attr("text-anchor", "left")
					.attr("alignment-baseline", "left")
					.attr("fill", this.settings.fontColor)
					.attr("font-size", font_size)
					.attr("font-weight", "bold")

			}
		})
		children.forEach((n: any) => {
			const g = fg.append('g')
			const rect = g.append("rect");
			const props = Object.entries(n);
			for (const [k, v] of props) {
				if (k === 'x' || k === 'y' || k === 'width' || k === 'height' || k === 'id')
					rect.attr(k, v);
			}
			//rect.attr("stroke", "blue");
			rect.attr("fill", this.settings.nodeColor);
		})
		edges.forEach((e: any) => {
			const fromPos = sidePositionOf(e.from.node, e.from.side);
			const toPos = sidePositionOf(e.to.node, e.to.side);


			const linkAnchor = (side: string) => {
				if (side == "left" || side == "right") return d3.linkHorizontal();
				else return d3.linkVertical();
			};
			const link = linkAnchor(e.fromSide)(
				{
					source: [fromPos.x, fromPos.y],
					target: [toPos.x, toPos.y]
				});
			//console.log(e, fromPos, toPos, link)
			fg
				.append("path")
				.attr("d", link)

				//修改 - 删除了箭头，以免在小地图上看起来很乱
				//.attr("marker-end", "url(#arrowhead-end)")
				.attr("stroke", "grey")
				.attr("stroke-width", 8)
				.attr("fill", "none");

		})

		bg.append('rect')
			.attr('id', 'minimap_viewport')
			.attr('fill', 'none')

	}

	renderCanvasViewport(canvas: any) {
		if(!this.settings.drawActiveViewport)
			return
		if(!canvas)
			return
		let canvas_bbox = canvas.getViewportBBox()
		const svg = d3.select('body')
			.select('#_minimap_ > svg')
		
		svg.select('#minimap_viewport')
			.attr('x', canvas_bbox.minX)
			.attr('y', canvas_bbox.minY)
			.attr('width', canvas_bbox.maxX - canvas_bbox.minX)
			.attr('height', canvas_bbox.maxY - canvas_bbox.minY)
			.attr('fill', 'azure')
			.attr('fill-opacity', '0.1')
			.attr('stroke', 'orange')
			.attr('stroke-width', '12')
	}

	onunload() {
		this.unloadMinimap()
	}

	static onCanvasUpdate(_:any, ctx: CanvasMinimap) {
		ctx.renderCanvasViewport(ctx.getActiveCanvas())
	}

	dispatchCanvasEvent(type: CanvasEventType, e: any) {
		this.canvas_event.trigger(type, e, this)
	}

	// adapt from https://github.com/Quorafind/Obsidian-Collapse-Node/blob/master/src/canvasCollapseIndex.ts#L89
	patchCanvas(canvas:any) {
		let that = this
		if(canvas){
			const uninstaller = around(canvas.constructor.prototype, {
				markMoved: (next: any) =>
					function (e: any) {
						next.call(this, e);
						that.dispatchCanvasEvent('CANVAS_MOVED', e)
					},
				markDirty: (next: any) =>
					function (e: any) {
						next.call(this, e);
						that.dispatchCanvasEvent('CANVAS_DIRTY', e)
					},
				markViewportChanged: (next: any) =>
					function () {
						next.call(this);
						that.dispatchCanvasEvent('CANVAS_VIEWPORT_CHANGED', null)
					},
				requestFrame: (next: any) =>
					function (e: any) {
						next.call(this, e);
						that.dispatchCanvasEvent('CANVAS_TICK', null)
					},
			});
			this.register(uninstaller);
			this.canvas_patched = true;
		}
		// register event listeners
		this.canvas_event.on('CANVAS_TICK', CanvasMinimap.onCanvasUpdate)
	}

	getActiveCanvas(): any {
		let currentView = this.app.workspace?.getActiveViewOfType(FileView)
		if(currentView?.getViewType() !== 'canvas')
			return null
		return (currentView as any)['canvas']
	}

	reloadMinimap() {
		this.unloadMinimap()
		this.setupMinimap()
	}
	unloadMinimap() {
		const active_canvas = this.getActiveCanvas()
		if (active_canvas) {
			// 修改：从body中移除小地图，而不是从画布容器中移除
			const container = d3.select('body')
			const minimap = container.select('#_minimap_')
			if (!minimap.empty()) {
				minimap.remove()
			}
			const toolbar = container.select('#_minimap_toolbar_')
			if (!toolbar.empty()) {
				toolbar.remove()
			}

			// remove canvas event listeners
			this.canvas_event.off('CANVAS_TICK', CanvasMinimap.onCanvasUpdate)
		}
	}
	
	// 添加一个新方法，用于将小地图移动到预设位置
	moveToPresetPosition() {
		if (!this.getActiveCanvas()) return;
		
		const active_canvas = this.getActiveCanvas();
		const div = d3.select('#_minimap_');
		
		if (div.empty()) return;
		
		let newX, newY;
		const rect = active_canvas.wrapperEl.getBoundingClientRect();
		switch (this.settings.side) {
			case 'top-right':
				newX = window.innerWidth - this.settings.width - 20;
				newY = 20;
				break;
			case 'top-left':
				newX = 20;
				newY = 20;
				break;
			case 'bottom-left':
				newX = 20;
				newY = window.innerHeight - this.settings.height - 20;
				break;
			case 'bottom-right':
				newX = window.innerWidth - this.settings.width - 20;
				newY = window.innerHeight - this.settings.height - 20;
				break;
		}
		
		// 更新位置
		div.style('left', newX + 'px')
			.style('top', newY + 'px');
		
		// 更新设置中的位置
		this.settings.positionX = newX;
		this.settings.positionY = newY;
		
		// 保存设置
		this.saveSettings();
	}
	
	setupMinimap() {
		if (!this.settings.enabled) return
		//let active_canvas = this.app.workspace.getActiveViewOfType("canvas")
		const active_canvas = this.getActiveCanvas()

		if (active_canvas) {
			this.patchCanvas(active_canvas)

			const container = d3.select(active_canvas.wrapperEl.parentNode)
			const toolbar = container.selectAll('.canvas-controls').filter(":not(#_minimap_toolbar_)")
			toolbar.style('display', 'flex') // restore toolbar if it was hidden
			const toolbar_item_rect = (toolbar.select('.canvas-control-item').node() as HTMLElement)?.getBoundingClientRect()

			let minimap = d3.select('#_minimap_')
			if (minimap.empty()) {

				
					const div = d3.select('body').append('div').attr('id', '_minimap_')
					.style('position', 'fixed') // 改为fixed定位
					.style('width', this.settings.width + 'px')
					.style('height', this.settings.height + 'px')
					.style('background-color', this.settings.backgroundColor) // 设置背景色
					.style('z-index', '40') // 降低层级，避免覆盖设置界面
					.style('opacity', this.settings.minimapOpacity) // 使用设置的透明度
					.style('pointer-events', 'all') // 允许交互
					.style('border', '2px solid #333')
					.style('border-radius', '5px')
					.style('overflow', 'hidden')
					.style('box-shadow', '0 4px 12px rgba(0,0,0,0.3)')

				// 根据设置的位置属性放置小地图，如果未设置则使用预设位置
				if (this.settings.positionX !== 0 || this.settings.positionY !== 0) {
					// 使用保存的位置
					div.style('left', this.settings.positionX + 'px')
						.style('top', this.settings.positionY + 'px')
				} else {
					// 使用预设位置
					const side = this.settings.side
					switch(side) {
						case 'top-right':
							div.style('top', '20px').style('right', '20px')
							break
						case 'top-left':
							div.style('top', '20px').style('left', '20px')
							break
						case 'bottom-left':
							div.style('bottom', '20px').style('left', '20px')
							break
						case 'bottom-right':
							div.style('bottom', '20px').style('right', '20px')
							break
					}
				}

				// 添加标题栏
				let isDragging = false;
				let offsetX = 0;
				let offsetY = 0;

				const header = div.insert('div', ':first-child')
					.attr('class', 'minimap-header')
					.style('position', 'absolute')
					.style('top', '0')
					.style('left', '0')
					.style('right', '0')
					.style('height', '20px')
					.style('background-color', 'rgba(0,0,0,0.3)')
					.style('cursor', 'move')
					.style('display', 'flex')
					.style('justify-content', 'space-between')
					.style('align-items', 'center')
					.style('padding', '0 4px')
					.style('z-index', '41'); // 降低标题栏层级

				header.append('span')
					.attr('class', 'minimap-title')
					.text('Canvas Minimap')
					.style('color', 'white')
					.style('font-size', '10px')
					.style('font-weight', 'bold');

				// 添加关闭按钮
				const closeBtn = header.append('span')
					.attr('class', 'minimap-close-btn')
					.html('&times;')
					.style('font-size', '14px')
					.on('click', (e) => {
						e.stopPropagation();
						this.settings.enabled = false;
						this.saveSettings();
						this.unloadMinimap();
					});

				// 拖动功能
				header.on('mousedown', (e) => {
					isDragging = true;
					const minimapNode = div.node();
					if (!minimapNode) return;
					const rect = minimapNode.getBoundingClientRect();
					offsetX = e.clientX - rect.left;
					offsetY = e.clientY - rect.top;
					div.style('transition', 'none'); // 拖动时禁用过渡效果
				});

				d3.select('body').on('mousemove', (e) => {
					if (isDragging) {
						div
							.style('left', (e.clientX - offsetX) + 'px')
							.style('top', (e.clientY - offsetY) + 'px');
					}
				}).on('mouseup', () => {
					if (isDragging) {
						isDragging = false;
						div.style('transition', 'box-shadow 0.2s ease'); // 拖动结束后恢复过渡效果
						
						// 保存当前位置
						const left = parseFloat(div.style('left'));
						const top = parseFloat(div.style('top'));
						this.settings.positionX = left;
						this.settings.positionY = top;
						this.saveSettings();
					}
				});

				// markers
				const svg = div.append('svg')
				const defs = svg.append("defs")
				defs
					.selectAll("marker")
					.data(["arrowhead-start", "arrowhead-end"]) // Unique ids for start and end markers
					.enter()
					.append("marker")
					.attr("id", (d: string) => d)
					.attr("markerWidth", 10)
					.attr("markerHeight", 7)
					.attr("refX", (d: string) => (d === "arrowhead-start" ? 10 : 0)) // Adjust refX for start and end markers
					.attr("refY", 3.5)
					.attr("orient", "auto")
					.append("polygon")
					.attr("points", (d: string) =>
						d === "arrowhead-start" ? "10 0, 0 3.5, 10 7" : "0 0, 10 3.5, 0 7"
					);

				minimap = d3.select('#_minimap_')
				svg.on('click', (e: any) => {
					const active_canvas = this.getActiveCanvas()

					const p = d3.pointer(e)
					const [x, y] = p
					const svg_bbox = BoundingBox.fromRect(svg.node()?.getBBox())

					if (!svg_bbox.contains(new Vector2(x, y))) {
						return
					}
					const svg_nodes = Array.from(svg.selectAll('rect').filter(":not(#minimap_viewport)").nodes())

					const target_nodes = svg_nodes.filter((n: any, i: number) => {
						const bbox = BoundingBox.fromRect(n.getBBox())
						return bbox.contains(new Vector2(x, y))
					}).map((n: any) => active_canvas.nodes?.get(n.id))

					if (target_nodes.length > 0) {
						// focus to nearest node
						let bbox = target_nodes[0].bbox
						let distSq = Vector2.lenSq(new Vector2(bbox.minX - x, bbox.minY - y))
						for (const n of target_nodes) {
							const current_bbox = n.bbox
							const current_distSq = Vector2.lenSq(new Vector2(current_bbox.minX - x, current_bbox.minY - y))
							if (current_distSq < distSq) {
								distSq = current_distSq
								bbox = current_bbox
							}
						}	
						const navigation_strategy = Keymap.isModifier(e, 'Ctrl') ? this.settings.secondaryNavigationStrategy : this.settings.primaryNavigationStrategy
						if(navigation_strategy === 'PAN'){
							active_canvas?.panTo(bbox.minX + (bbox.maxX - bbox.minX) / 2, bbox.minY + (bbox.maxY - bbox.minY) / 2)
						}else if(navigation_strategy === 'ZOOM'){
							active_canvas?.zoomToBbox(bbox)
						}
					}

				})
				// 不再需要在container上注册点击事件，因为svg已经能接收点击事件了
			}

			this.renderMinimap(d3.select('#_minimap_>svg'), active_canvas)
		}
	}

	async loadSettings() {
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.reloadMinimap()
	}
}


class CanvasMinimapSettingTab extends PluginSettingTab {
	plugin: CanvasMinimap;

	constructor(app: App, plugin: CanvasMinimap) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName(t('width'))
			.setDesc(t('widthDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.width.toString())
				.onChange(async (value) => {
					if(value && !isNaN(Number(value))){
						this.plugin.settings.width = parseInt(value);
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName(t('height'))
			.setDesc(t('heightDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.height.toString())
				.onChange(async (value) => {
				if(value && !isNaN(Number(value))){ 
					this.plugin.settings.height = parseInt(value);
					await this.plugin.saveSettings();
				}
			}));

		new Setting(containerEl)
			.setName(t('margin'))
			.setDesc(t('marginDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.margin.toString())
				.onChange(async (value) => {
					this.plugin.settings.margin = parseInt(value);
					await this.plugin.saveSettings();
				}));

			// 添加透明度设置
		new Setting(containerEl)
			.setName(t('minimapOpacity'))
			.setDesc(t('minimapOpacityDesc'))
			.addSlider(slider => slider
				.setLimits(0.1, 1, 0.05)
				.setValue(this.plugin.settings.minimapOpacity)
				.onChange(async (value) => {
					this.plugin.settings.minimapOpacity = value;
					await this.plugin.saveSettings();
				}))
			.addExtraButton(button => button
				.setIcon('reset')
				.setTooltip('Reset to default')
				.onClick(async () => {
					this.plugin.settings.minimapOpacity = DEFAULT_SETTINGS.minimapOpacity;
					await this.plugin.saveSettings();
					this.display();
				}));



		new Setting(containerEl)
			.setName(t('fontSize'))
			.setDesc(t('fontSizeDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.fontSize.toString())
				.onChange(async (value) => {
					this.plugin.settings.fontSize = parseInt(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('fontColor'))
			.setDesc(t('fontColorDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.fontColor)
				.onChange(async (value) => {
					this.plugin.settings.fontColor = value;
					await this.plugin.saveSettings();
				}));

		// 修改位置设置，添加下拉框和应用按钮
		new Setting(containerEl)
			.setName(t('side'))
			.setDesc(t('sideDesc'))
			.addDropdown(dropdown => dropdown
				.addOptions({
					'top-right': t('topRight'),
					'top-left': t('topLeft'),
					'bottom-left': t('bottomLeft'),
					'bottom-right': t('bottomRight')
				})
				.setValue(this.plugin.settings.side)
				.onChange(async (value) => {
					this.plugin.settings.side = value as MinimapSide;
					await this.plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText(t('applyPosition'))
				.setCta()
				.onClick(async () => {
					// 只重置一次位置，不锁定
					this.plugin.moveToPresetPosition();
				}));

		new Setting(containerEl)
			.setName(t('enabled'))
			.setDesc(t('enabledDesc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enabled)
				.onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('backgroundColor'))
			.setDesc(t('backgroundColorDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.backgroundColor)
				.onChange(async (value) => {
					this.plugin.settings.backgroundColor = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('groupColor'))
			.setDesc(t('groupColorDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.groupColor)
				.onChange(async (value) => {
					this.plugin.settings.groupColor = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('hijackToolbar'))
			.setDesc(t('hijackToolbarDesc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hijackToolbar)
				.onChange(async (value) => {
					this.plugin.settings.hijackToolbar = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('drawActiveViewport'))
			.setDesc(t('drawActiveViewportDesc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.drawActiveViewport)
				.onChange(async (value) => {
					this.plugin.settings.drawActiveViewport = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName(t('primaryNavigationStrategy'))
			.setDesc(t('primaryNavigationStrategyDesc'))
			.addDropdown(dropdown => dropdown
				.addOptions({
					'PAN': t('pan'),
					'ZOOM': t('zoom'),
					'NONE': t('none')
				})
				.setValue(this.plugin.settings.primaryNavigationStrategy)
				.onChange(async (value) => {
					this.plugin.settings.primaryNavigationStrategy = value as CanvasNavigationStrategy;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('secondaryNavigationStrategy'))
			.setDesc(t('secondaryNavigationStrategyDesc'))
			.addDropdown(dropdown => dropdown
				.addOptions({
					'PAN': t('pan'),
					'ZOOM': t('zoom'),
					'NONE': t('none')
				})
				.setValue(this.plugin.settings.secondaryNavigationStrategy)
				.onChange(async (value) => {
					this.plugin.settings.secondaryNavigationStrategy = value as CanvasNavigationStrategy;
					await this.plugin.saveSettings();
				}));
	}
}