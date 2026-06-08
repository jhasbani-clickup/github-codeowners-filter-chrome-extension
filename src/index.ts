interface CodeOwner {
  name: string;
  files: Set<HTMLElement>;
}

type FilesChangedExperience = 'classic' | 'new';

function getFilesChangedExperience(): FilesChangedExperience | null {
  // The classic /files view keeps the SelectMenu filter even when a file tree is present.
  if (document.querySelector('.SelectMenu.js-file-filter')) {
    return 'classic';
  }

  if (
    document.querySelector('#diff-file-tree-filter') ||
    document.querySelector('a#prs-files-anchor-tab[href*="/changes"]')
  ) {
    return 'new';
  }

  return null;
}

function isPRFilesPage(): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/(files|changes)/.test(
    window.location.href,
  );
}

class GitHubCodeOwnersFilter {
  private codeowners: Map<string, CodeOwner> = new Map();
  private observer: MutationObserver;
  private isInitialized = false;
  private filterListenersAttached = false;
  private lastScannedFileCount = 0;
  private initializeInProgress = false;

  constructor() {
    console.debug(
      `[GitHub Code owners Filter]: Initializing (${getFilesChangedExperience() ?? 'unknown'} UI)`,
    );
    this.observer = new MutationObserver(this.handleMutations.bind(this));
    this.startObserving();
    this.attachFilterListeners();
    this.tryInitialize();
  }

  private getExperience(): FilesChangedExperience | null {
    return getFilesChangedExperience();
  }

  private isNewExperience(): boolean {
    return this.getExperience() === 'new';
  }

  private startObserving(): void {
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  private attachFilterListeners(): void {
    if (this.filterListenersAttached) {
      return;
    }

    const newFilterButton = document.querySelector(
      '#diff-file-tree-filter button[aria-haspopup="true"]',
    );
    newFilterButton?.addEventListener('click', () => {
      window.setTimeout(() => this.tryInitialize(), 0);
    });

    const classicFilterDetails = document
      .querySelector('.SelectMenu.js-file-filter')
      ?.closest('details');
    classicFilterDetails?.addEventListener('toggle', () => {
      if (classicFilterDetails.open) {
        window.setTimeout(() => this.tryInitialize(), 0);
      }
    });

    if (newFilterButton || classicFilterDetails) {
      this.filterListenersAttached = true;
    }
  }

  private tryInitialize(): void {
    this.handleMutations();
  }

  private handleMutations(): void {
    this.attachFilterListeners();

    if (this.isNewExperience()) {
      this.tryInitializeNewExperience();
      return;
    }

    this.tryInitializeClassicExperience();
  }

  private tryInitializeClassicExperience(): void {
    const filterMenu = document.querySelector('.SelectMenu.js-file-filter');
    if (!filterMenu) {
      return;
    }

    const details = filterMenu.closest('details');
    if (details && !details.open) {
      return;
    }

    console.debug('[GitHub Code owners Filter]: Found classic filter menu, initializing');
    this.initialize(filterMenu as HTMLElement).catch((error) => {
      console.error('[GitHub Code owners Filter]: Error during initialization:', error);
    });
  }

  private tryInitializeNewExperience(): void {
    const filterMenu = this.findNewExperienceFilterMenu();
    if (!filterMenu || filterMenu.querySelector('.js-codeowner-section')) {
      return;
    }

    console.debug('[GitHub Code owners Filter]: Found new filter menu, initializing');
    this.initialize(filterMenu).catch((error) => {
      console.error('[GitHub Code owners Filter]: Error during initialization:', error);
    });
  }

  private findNewExperienceFilterMenu(): HTMLElement | null {
    const menus = document.querySelectorAll('ul[data-component="ActionList"][role="menu"]');
    for (const menu of menus) {
      if (menu.textContent?.includes('File extensions')) {
        return menu as HTMLElement;
      }
    }

    return null;
  }

  private getFileElements(): NodeListOf<HTMLElement> {
    if (this.isNewExperience()) {
      return document.querySelectorAll('[class*="PullRequestDiffsList-module__diffEntry"]');
    }

    return document.querySelectorAll('#files copilot-diff-entry');
  }

  private getExpectedFileCount(): number | null {
    const counter = document.querySelector('#files_tab_counter');
    const counterTitle = counter?.getAttribute('title');
    if (counterTitle) {
      return parseInt(counterTitle.replace(/,/g, ''), 10);
    }

    const filesTab = document.querySelector('a#prs-files-anchor-tab');
    const tabMatch = filesTab?.textContent?.match(/\((\d+)\)/);
    if (tabMatch) {
      return parseInt(tabMatch[1], 10);
    }

    return this.getFileElements().length || null;
  }

  private async waitForAllFiles(expectedCount: number): Promise<NodeListOf<HTMLElement>> {
    const maxAttempts = 45;
    let attempts = 0;

    while (attempts < maxAttempts) {
      const files = this.getFileElements();
      console.debug(`[GitHub Code owners Filter]: Found ${files.length}/${expectedCount} files`);

      if (files.length >= expectedCount) {
        return files;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    }

    console.warn(
      `[GitHub Code owners Filter]: Only found ${this.getFileElements().length}/${expectedCount} files after 45 seconds`,
    );
    return this.getFileElements();
  }

  private async initialize(filterMenu: HTMLElement): Promise<void> {
    if (this.initializeInProgress) {
      return;
    }

    this.initializeInProgress = true;

    try {
      const expectedFileCount = this.getExpectedFileCount();
      if (!expectedFileCount) {
        console.debug('[GitHub Code owners Filter]: Could not determine expected file count');
        return;
      }

      if (!filterMenu.querySelector('.js-codeowner-section')) {
        this.createCodeOwnersFilterSection(filterMenu, expectedFileCount);
      }

      const fileList = await this.waitForAllFiles(expectedFileCount);
      if (!fileList.length) {
        console.debug('[GitHub Code owners Filter]: No file list found');
        return;
      }

      const hasFilterOptions = filterMenu.querySelector('.js-codeowner-option');
      const shouldRescan =
        fileList.length > this.lastScannedFileCount ||
        (this.isNewExperience() && !hasFilterOptions);

      if (shouldRescan) {
        this.codeowners.clear();
        this.scanCodeOwners(fileList);
        this.lastScannedFileCount = fileList.length;
        console.debug('[GitHub Code owners Filter]: Code owners scanned');
      }

      this.addCodeOwnerFilters(filterMenu);

      if (!this.isInitialized && fileList.length >= expectedFileCount) {
        this.isInitialized = true;
        this.observer.disconnect();
        console.debug(
          '[GitHub Code owners Filter]: Extension fully initialized and observer disconnected',
        );
      }
    } finally {
      this.initializeInProgress = false;
    }
  }

  private getOwnershipText(element: HTMLElement): string | null {
    const ownershipIcon = element.querySelector('.file-info .octicon-shield-lock, .octicon-shield-lock');
    if (!ownershipIcon) {
      return null;
    }

    const shieldLink = ownershipIcon.closest('a');
    const linkLabel = shieldLink?.getAttribute('aria-label');
    if (linkLabel) {
      return linkLabel;
    }

    const tooltipId = shieldLink?.getAttribute('aria-labelledby');
    if (tooltipId) {
      const tooltip =
        element.querySelector(`#${CSS.escape(tooltipId)}`) ??
        document.getElementById(tooltipId);
      if (tooltip?.textContent) {
        return tooltip.textContent.trim();
      }
    }

    const labeled = ownershipIcon.closest('[aria-label]');
    return labeled?.getAttribute('aria-label') || null;
  }

  private getFilePath(element: HTMLElement): string | null {
    if (this.isNewExperience()) {
      const filePathLink = element.querySelector('[class*="DiffFileHeader"] a[href^="#diff-"]');
      const filePath = filePathLink?.textContent?.replace(/\u200e/g, '').trim();
      if (filePath) {
        return filePath;
      }
    }

    const pathElement = element.querySelector('[data-path], [data-file-path]');
    return pathElement?.getAttribute('data-path') || pathElement?.getAttribute('data-file-path') || null;
  }

  private scanCodeOwners(fileList: NodeListOf<HTMLElement>): void {
    console.debug(`[GitHub Code owners Filter]: Scanning ${fileList.length} files for ownership`);

    fileList.forEach((element) => {
      const ownershipText = this.getOwnershipText(element);
      if (!ownershipText) {
        return;
      }

      const owners = this.parseOwners(ownershipText);
      const filePath = this.getFilePath(element);
      if (filePath) {
        element.dataset.codeownerFilePath = filePath;
      }

      owners.forEach((owner) => {
        if (!this.codeowners.has(owner)) {
          this.codeowners.set(owner, {
            name: owner,
            files: new Set(),
          });
        }

        this.codeowners.get(owner)?.files.add(element);
      });
    });

    console.debug(`[GitHub Code owners Filter]: Found ${this.codeowners.size} code owners`);
  }

  private parseOwners(text: string): string[] {
    const hasYou = text.includes('Owned by you');
    const mentions = text.match(/(@[\w/-]+)/g) || [];
    return hasYou ? ['You', ...mentions] : mentions;
  }

  private createCodeOwnersFilterSection(filterMenu: HTMLElement, expectedFileCount: number): void {
    if (this.isNewExperience()) {
      this.createNewExperienceFilterSection(filterMenu, expectedFileCount);
      return;
    }

    this.createClassicFilterSection(filterMenu, expectedFileCount);
  }

  private createClassicFilterSection(filterMenu: HTMLElement, expectedFileCount: number): void {
    const section = document.createElement('section');
    section.className = 'js-codeowner-section';

    const divider = document.createElement('hr');
    divider.className = 'SelectMenu-divider';

    const header = document.createElement('div');
    header.className = 'SelectMenu-header';
    header.innerHTML = '<h3 class="SelectMenu-title">Filter by code owner</h3>';

    const container = document.createElement('div');
    container.className = 'SelectMenu-list';
    container.appendChild(this.createFooterItem(`Loading code owners for ${expectedFileCount} files...`));

    section.appendChild(divider);
    section.appendChild(header);
    section.appendChild(container);

    const menuList = filterMenu.querySelector('.SelectMenu-list');
    if (menuList) {
      console.debug(
        '[GitHub Code owners Filter]: Adding initial code owner section to classic filter menu',
      );
      menuList.appendChild(section);
    }
  }

  private createNewExperienceFilterSection(filterMenu: HTMLElement, expectedFileCount: number): void {
    const group = document.createElement('li');
    group.className = 'js-codeowner-section prc-ActionList-Group-lMIPQ';
    group.setAttribute('data-component', 'ActionList.Group');
    group.setAttribute('role', 'none');

    const headingWrap = document.createElement('div');
    headingWrap.setAttribute('role', 'presentation');
    headingWrap.setAttribute('aria-hidden', 'true');
    headingWrap.setAttribute('data-variant', 'subtle');
    headingWrap.setAttribute('data-component', 'GroupHeadingWrap');
    headingWrap.className = 'prc-ActionList-GroupHeadingWrap-laXcX';

    const heading = document.createElement('span');
    heading.className = 'prc-ActionList-GroupHeading-STzxi';
    heading.textContent = 'Filter by code owner';
    headingWrap.appendChild(heading);

    const list = document.createElement('ul');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Filter by code owner');
    list.className = 'prc-ActionList-GroupList-V5B3- js-codeowner-list';

    const footerItem = document.createElement('li');
    footerItem.className =
      'js-codeowner-footer color-fg-muted f6 px-3 py-2 border-top color-border-muted';
    footerItem.textContent = `Loading code owners for ${expectedFileCount} files...`;
    footerItem.style.pointerEvents = 'none';
    footerItem.style.listStyle = 'none';
    list.appendChild(footerItem);

    group.appendChild(headingWrap);
    group.appendChild(list);
    filterMenu.appendChild(group);

    console.debug(
      '[GitHub Code owners Filter]: Adding initial code owner section to new filter menu',
    );
  }

  private createFooterItem(text: string): HTMLElement {
    const footerItem = document.createElement('div');
    footerItem.className = 'SelectMenu-item SelectMenu-footer-item js-codeowner-footer color-fg-muted';
    footerItem.textContent = text;
    footerItem.style.pointerEvents = 'none';
    return footerItem;
  }

  private addCodeOwnerFilters(filterMenu: HTMLElement): void {
    const container = this.isNewExperience()
      ? filterMenu.querySelector('.js-codeowner-section .js-codeowner-list')
      : filterMenu.querySelector('.js-codeowner-section .SelectMenu-list');

    if (!container) {
      return;
    }

    const footerItem = container.querySelector('.js-codeowner-footer');

    container
      .querySelectorAll('.js-codeowner-option')
      .forEach((option) => option.closest('label, li')?.remove());

    if (this.codeowners.size === 0 && footerItem) {
      footerItem.textContent = 'No code owners found';
      console.debug('[GitHub Code owners Filter]: No code owners found, skipping filter creation');
      return;
    }

    const owners = Array.from(this.codeowners.values()).sort((a, b) =>
      b.name.localeCompare(a.name),
    );
    const youIndex = owners.findIndex((owner) => owner.name === 'You');

    if (youIndex !== -1) {
      const youOwner = owners.splice(youIndex, 1)[0];
      owners.unshift(youOwner);
    }

    console.debug('[GitHub Code owners Filter]: Adding code owners to menu');
    owners.forEach((owner) => {
      const label = this.createLabel(owner);
      if (footerItem) {
        container.insertBefore(label, footerItem);
      } else {
        container.appendChild(label);
      }
    });

    if (!footerItem) {
      return;
    }

    const filesWithOwnership = new Set(
      Array.from(this.codeowners.values()).flatMap((owner) => Array.from(owner.files)),
    );

    const filesWithoutOwnership = this.getFileElements().length - filesWithOwnership.size;

    if (filesWithoutOwnership === 0) {
      footerItem.textContent = 'All files have ownership!';
      return;
    }

    footerItem.textContent = `${filesWithoutOwnership} files do not have ownership`;
  }

  private createLabel({ name, files }: CodeOwner): HTMLElement {
    if (this.isNewExperience()) {
      return this.createNewExperienceLabel(name, files.size);
    }

    return this.createClassicLabel(name, files.size);
  }

  private createClassicLabel(name: string, fileCount: number): HTMLElement {
    const label = document.createElement('label');
    label.className = 'SelectMenu-item';
    label.setAttribute('role', 'menuitem');

    const input = document.createElement('input');
    input.className = 'js-codeowner-option mr-2';
    input.type = 'checkbox';
    input.value = name;
    input.addEventListener('change', (e) => {
      e.stopPropagation();
      this.handleCodeOwnerFilter();
    });

    const text = document.createTextNode(`${name} `);
    const count = document.createElement('span');
    count.className = 'text-normal js-file-type-count';
    count.style.marginLeft = 'auto';
    count.textContent = `(${fileCount})`;

    label.appendChild(input);
    label.appendChild(text);
    label.appendChild(count);

    return label;
  }

  private createNewExperienceLabel(name: string, fileCount: number): HTMLElement {
    const item = document.createElement('li');
    item.className = 'prc-ActionList-ActionListItem-So4vC';
    item.setAttribute('role', 'menuitemcheckbox');
    item.setAttribute('aria-checked', 'false');
    item.setAttribute('tabindex', '-1');
    item.setAttribute('data-component', 'ActionList.Item');

    const input = document.createElement('input');
    input.className = 'js-codeowner-option';
    input.type = 'checkbox';
    input.value = name;
    input.hidden = true;

    const content = document.createElement('div');
    content.className = 'prc-ActionList-ActionListContent-KBb8-';
    content.setAttribute('data-size', 'medium');

    const spacer = document.createElement('span');
    spacer.className = 'prc-ActionList-Spacer-4tR2m';

    const leading = document.createElement('span');
    leading.className = 'prc-ActionList-LeadingAction-hbWbh prc-ActionList-VisualWrap-bdCsS';
    leading.setAttribute('data-component', 'ActionList.Selection');

    const checkIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    checkIcon.setAttribute('aria-hidden', 'true');
    checkIcon.setAttribute('focusable', 'false');
    checkIcon.setAttribute('class', 'octicon octicon-check prc-ActionList-SingleSelectCheckmark-zMd8d');
    checkIcon.setAttribute('viewBox', '0 0 16 16');
    checkIcon.setAttribute('width', '16');
    checkIcon.setAttribute('height', '16');
    checkIcon.setAttribute('fill', 'currentColor');
    checkIcon.style.visibility = 'hidden';
    checkIcon.innerHTML =
      '<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path>';
    leading.appendChild(checkIcon);

    const subContent = document.createElement('span');
    subContent.className = 'prc-ActionList-ActionListSubContent-gKsFp';
    subContent.setAttribute('data-component', 'ActionList.Item--DividerContainer');

    const label = document.createElement('span');
    label.className = 'prc-ActionList-ItemLabel-81ohH';
    label.setAttribute('data-component', 'ActionList.Item.Label');
    label.textContent = name;

    const trailing = document.createElement('span');
    trailing.className = 'prc-ActionList-TrailingVisual-jwT9C prc-ActionList-VisualWrap-bdCsS';
    trailing.setAttribute('data-component', 'ActionList.TrailingVisual');

    const count = document.createElement('span');
    count.setAttribute('aria-hidden', 'true');
    count.setAttribute('data-variant', 'secondary');
    count.setAttribute('data-component', 'CounterLabel');
    count.className = 'prc-CounterLabel-CounterLabel-X-kRU';
    count.textContent = String(fileCount);

    const hiddenCount = document.createElement('span');
    hiddenCount.className = 'prc-VisuallyHidden-VisuallyHidden-Q0qSB';
    hiddenCount.textContent = ` (${fileCount})`;

    trailing.appendChild(count);
    trailing.appendChild(hiddenCount);
    subContent.appendChild(label);
    subContent.appendChild(trailing);

    content.appendChild(spacer);
    content.appendChild(leading);
    content.appendChild(subContent);
    item.appendChild(content);
    item.appendChild(input);

    const setChecked = (checked: boolean): void => {
      input.checked = checked;
      item.setAttribute('aria-checked', checked ? 'true' : 'false');
      checkIcon.style.visibility = checked ? 'visible' : 'hidden';
    };

    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setChecked(!input.checked);
      this.handleCodeOwnerFilter();
    });

    return item;
  }

  private handleCodeOwnerFilter(): void {
    const selectedOwners = Array.from(
      document.querySelectorAll('.js-codeowner-option:checked'),
    ).map((input) => (input as HTMLInputElement).value);

    this.getFileElements().forEach((file) => {
      const ownershipText = this.getOwnershipText(file);
      const fileOwners = ownershipText ? this.parseOwners(ownershipText) : [];
      const shouldShow =
        selectedOwners.length === 0 || selectedOwners.some((owner) => fileOwners.includes(owner));

      file.style.display = shouldShow ? '' : 'none';
      this.setTreeItemVisibility(file, shouldShow);
    });
  }

  private setTreeItemVisibility(file: HTMLElement, shouldShow: boolean): void {
    if (!this.isNewExperience()) {
      return;
    }

    const filePath = file.dataset.codeownerFilePath || this.getFilePath(file);
    if (!filePath) {
      return;
    }

    const treeItem = document.querySelector(`li.PRIVATE_TreeView-item[id="${CSS.escape(filePath)}"]`);
    if (treeItem instanceof HTMLElement) {
      treeItem.style.display = shouldShow ? '' : 'none';
    }
  }
}

let activeFilter: GitHubCodeOwnersFilter | null = null;
let activeUrl = '';

function startFilterIfNeeded(): void {
  if (!isPRFilesPage()) {
    activeFilter = null;
    activeUrl = '';
    return;
  }

  const url = window.location.href;
  if (activeFilter && activeUrl === url) {
    return;
  }

  activeFilter = new GitHubCodeOwnersFilter();
  activeUrl = url;
}

startFilterIfNeeded();
document.addEventListener('turbo:load', startFilterIfNeeded);
document.addEventListener('turbo:render', startFilterIfNeeded);
