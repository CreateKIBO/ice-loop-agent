import '@shoelace-style/shoelace/dist/components/split-panel/split-panel.js';
import '@shoelace-style/shoelace/dist/components/tab-group/tab-group.js';
import '@shoelace-style/shoelace/dist/components/tab/tab.js';
import '@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js';
const names=['MessageSquare','FileText','CheckCheck','Image','Globe','Plus','Send','Square','PanelRightClose','Paperclip','ArrowUpRight','History','Settings','Search','RotateCcw','Archive','Pencil','Copy','ChevronDown','LoaderCircle','MessageCircleQuestion','CircleAlert','Check','FilePlus2','FilePenLine','Save','GitBranch','Trash2'];
names.push('PanelLeftClose','ListTodo','BookOpen','CircleUserRound','SlidersHorizontal');
window.iceComponents = { icons: () => window.lucide.createIcons({ icons: Object.fromEntries(names.map(name=>[name,window.lucide[name]])) }) };
