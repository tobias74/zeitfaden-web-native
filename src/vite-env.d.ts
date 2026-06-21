/// <reference types="vite/client" />

type FileSystemPermissionMode = 'read' | 'readwrite'

interface FileSystemPermissionDescriptor {
  mode?: FileSystemPermissionMode
}

interface FileSystemHandle {
  readonly kind: 'file' | 'directory'
  readonly name: string
  isSameEntry?(other: FileSystemHandle): Promise<boolean>
  queryPermission?(
    descriptor?: FileSystemPermissionDescriptor,
  ): Promise<PermissionState>
  requestPermission?(
    descriptor?: FileSystemPermissionDescriptor,
  ): Promise<PermissionState>
}

interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: 'file'
  getFile(): Promise<File>
  createWritable?: () => Promise<{
    write: (data: Blob | BufferSource | string) => Promise<void>
    close: () => Promise<void>
  }>
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: 'directory'
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  values(): AsyncIterableIterator<FileSystemHandle>
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandle>
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle>
}

interface Window {
  showDirectoryPicker?: (options?: {
    mode?: FileSystemPermissionMode
  }) => Promise<FileSystemDirectoryHandle>
  showOpenFilePicker?: (options?: {
    multiple?: boolean
    types?: Array<{
      description?: string
      accept: Record<string, string[]>
    }>
  }) => Promise<FileSystemFileHandle[]>
}
