const messages = {
  zh: {
    pdfUnavailable: '当前浏览器未提供 PDF 预览，可用系统应用打开。',
    title: '文件', subtitle: '让文件，触手可及。', places: '常用位置', home: '个人目录', desktop: '桌面', documents: '文稿', downloads: '下载', pictures: '图片', projects: '项目', movies: '影片', music: '音乐', tmp: '临时目录',
    back: '后退', forward: '前进', up: '上一级', refresh: '刷新', path: '目录路径', go: '前往', search: '搜索此目录及子目录', searchAction: '搜索', clear: '清除搜索', content: '搜索文件内容', hidden: '隐藏文件',
    newFolder: '新建文件夹', newFile: '新建文本文件', upload: '上传文件', uploading: '正在上传', cancel: '取消', create: '创建', save: '保存', rename: '重命名', name: '名称', size: '大小', modified: '修改时间', type: '类型',
    preview: '预览', details: '详情', noSelection: '选择文件以查看预览', previewHint: '支持文本、图片、PDF 和音视频。双击文件夹打开。', loading: '正在加载…', empty: '这个文件夹是空的', emptyHint: '新建文件夹，或上传文件开始整理。', noResults: '没有找到匹配的文件', noResultsHint: '试试其他关键词，或清除搜索返回目录。',
    copy: '复制', cut: '剪切', paste: '粘贴', duplicate: '制作副本', trash: '移到废纸篓', open: '用系统应用打开', reveal: '在系统文件管理器中显示', copyPath: '复制路径', zip: '压缩为 ZIP', extract: '解压到文件夹', more: '更多操作', selectAll: '选择当前已加载项目', select: '选择', close: '关闭预览',
    selected: '已选择 {count} 项', items: '{count} 个项目', loadMore: '加载更多', live: '变更自动同步', reconnect: '正在重新连接…', readOnly: '只读模式', ready: '就绪', edited: '未保存', saved: '已保存', edit: '编辑文本', discard: '放弃修改', unsaved: '有未保存的修改', unsavedHint: '离开此文件会丢弃当前编辑内容。',
    conflict: '文件已被其他程序修改或删除，未覆盖原文件。请复制当前内容后重新打开文件。', truncated: '文件过大，仅显示部分内容，无法在此编辑。', previewLimit: '文件超过内置预览上限，可用系统应用打开。', unsupported: '此类型暂不支持内置预览，可用系统应用打开。', binaryError: '无法预览此文件，可用系统应用打开。',
    failed: '操作失败：{message}', retry: '重试', done: '操作完成', partial: '已完成 {count} 项，{failed} 项失败。', trashTitle: '移到废纸篓？', trashHint: '将所选的 {count} 个项目移到系统废纸篓，可在系统中恢复。', destination: '目标文件夹的完整路径', zipName: '压缩文件名称', copied: '已复制路径', clipboard: '{count} 项待{action}', copyVerb: '复制', moveVerb: '移动',
    uploadDone: '已上传 {count} 个文件', uploadCancelled: '上传已取消，已完成的文件会保留。', uploadFailed: '已上传 {count} 个文件，后续上传失败：{message}', uploadLimit: '文件「{name}」超过上传限制。', renamedUpload: '同名文件将自动重命名。', cancelled: '已取消', searchLimited: '结果达到搜索上限，试着缩小目录或关键词范围。',
    file: '文件', dir: '文件夹', text: '文本', image: '图片', pdf: 'PDF', audio: '音频', video: '视频', archive: '压缩文件', other: '文件', pathLabel: '完整路径', pageError: '无法读取目录', bootError: '无法连接文件服务', folderName: '文件夹名称', fileName: '文件名称', newFolderDefault: '未命名文件夹', newFileDefault: '未命名.txt', archiveEmpty: '压缩包中没有条目', permission: '部分系统操作不可用', draftHint: '保存时会检查文件是否在外部发生变化。', tooMany: '一次最多选择 {count} 项。',
  },
  en: {
    pdfUnavailable: 'This browser does not provide a PDF viewer. Open the file in the default app.',
    title: 'Files', subtitle: 'Your files, within reach.', places: 'Favorites', home: 'Home', desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures', projects: 'Projects', movies: 'Movies', music: 'Music', tmp: 'Temporary files',
    back: 'Back', forward: 'Forward', up: 'Up one level', refresh: 'Refresh', path: 'Directory path', go: 'Go', search: 'Search this folder and subfolders', searchAction: 'Search', clear: 'Clear search', content: 'Search file contents', hidden: 'Hidden files',
    newFolder: 'New folder', newFile: 'New text file', upload: 'Upload files', uploading: 'Uploading', cancel: 'Cancel', create: 'Create', save: 'Save', rename: 'Rename', name: 'Name', size: 'Size', modified: 'Modified', type: 'Type',
    preview: 'Preview', details: 'Details', noSelection: 'Select a file to preview', previewHint: 'Text, images, PDF, audio and video. Double-click a folder to open it.', loading: 'Loading…', empty: 'This folder is empty', emptyHint: 'Create a folder or upload files to get started.', noResults: 'No matching files', noResultsHint: 'Try another keyword or clear the search.',
    copy: 'Copy', cut: 'Cut', paste: 'Paste', duplicate: 'Duplicate', trash: 'Move to trash', open: 'Open in default app', reveal: 'Show in file manager', copyPath: 'Copy path', zip: 'Compress to ZIP', extract: 'Extract to folder', more: 'More actions', selectAll: 'Select all loaded items', select: 'Select', close: 'Close preview',
    selected: '{count} selected', items: '{count} items', loadMore: 'Load more', live: 'Changes sync automatically', reconnect: 'Reconnecting…', readOnly: 'Read-only mode', ready: 'Ready', edited: 'Unsaved', saved: 'Saved', edit: 'Edit text', discard: 'Discard changes', unsaved: 'Unsaved changes', unsavedHint: 'Leaving this file will discard the current edits.',
    conflict: 'The file changed or was deleted elsewhere. Nothing was overwritten. Copy your edits before reopening it.', truncated: 'Only part of this large file is shown. Editing is disabled.', previewLimit: 'The file exceeds the preview limit. Open it in the default app.', unsupported: 'No built-in preview for this file type. Open it in the default app.', binaryError: 'Cannot preview this file. Open it in the default app.',
    failed: 'Operation failed: {message}', retry: 'Retry', done: 'Done', partial: '{count} completed, {failed} failed.', trashTitle: 'Move to trash?', trashHint: 'Move {count} selected items to the system trash. You can restore them in your file manager.', destination: 'Full destination folder path', zipName: 'Archive filename', copied: 'Path copied', clipboard: '{count} items to {action}', copyVerb: 'copy', moveVerb: 'move',
    uploadDone: '{count} files uploaded', uploadCancelled: 'Upload cancelled. Completed files are kept.', uploadFailed: '{count} uploaded; the next upload failed: {message}', uploadLimit: '“{name}” exceeds the upload limit.', renamedUpload: 'Existing filenames are renamed automatically.', cancelled: 'Cancelled', searchLimited: 'Search limits reached. Narrow the folder or search terms.',
    file: 'File', dir: 'Folder', text: 'Text', image: 'Image', pdf: 'PDF', audio: 'Audio', video: 'Video', archive: 'Archive', other: 'File', pathLabel: 'Full path', pageError: 'Cannot read this folder', bootError: 'Cannot connect to the file service', folderName: 'Folder name', fileName: 'Filename', newFolderDefault: 'Untitled folder', newFileDefault: 'Untitled.txt', archiveEmpty: 'This archive is empty', permission: 'Some system actions are unavailable', draftHint: 'Saving checks for changes made outside this editor.', tooMany: 'Select at most {count} items at a time.',
  },
};

export const language = typeof location === 'undefined' ? 'zh' : new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
export function t(key, values = {}) {
  let text = messages[language][key] ?? key;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
export { messages };
