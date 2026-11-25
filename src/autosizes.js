(async function () {
  if (
    !('PerformanceObserver' in window) ||
    !PerformanceObserver.supportedEntryTypes.includes('paint')
  ) {
    return;
  }

  const probe = document.createElement('img');
  probe.style.setProperty('display', 'none', 'important');
  probe.style.setProperty('contain', 'revert', 'important');
  probe.sizes = 'auto';
  document.documentElement.append(probe);
  const hasNativeAutoSizes = getComputedStyle(probe).contain === 'size';
  probe.remove();

  if (hasNativeAutoSizes) {
    // Blink gates explicit two-dimensional sizes and object-fit-aware auto
    // sizing together. Test the parser on the detached image to avoid layout.
    probe.width = 40;
    probe.height = 20;
    probe.sizes = 'cover 10px 10px, 7px';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>';
    probe.srcset = `data:image/svg+xml,${encodeURIComponent(svg)} 40w`;
    try {
      await probe.decode();
      if (probe.naturalWidth === 20) {
        return;
      }
    } catch {
      // A blocked or failed probe leaves the object-fit correction enabled.
    }
  }

  const attributes = ['src', 'srcset'];
  // The original src and srcset values of images whose loading we deferred, keyed by element.
  // These are kept in memory rather than in the DOM (e.g. in data-* attributes), so that only
  // values the polyfill itself removed can ever be restored. Otherwise, page content carrying
  // such attributes (e.g. sanitized user HTML that strips src but keeps data-* attributes)
  // could get the polyfill to load arbitrary URLs.
  const deferredImages = new Map();
  let didFirstContentfulPaintRun = false;

  function isLazyAutoSized(img) {
    return /^auto\s*(?:,|$)/i.test(img.sizes.trim())
      && img.getAttribute('loading')?.toLowerCase() === 'lazy';
  }

  function canCorrectNativeSizing(img) {
    return isLazyAutoSized(img) && img.srcset
      && img.hasAttribute('width') && img.hasAttribute('height');
  }

  function getImageSourceWidth(img) {
    const style = getComputedStyle(img);
    const {objectFit} = style;
    if (hasNativeAutoSizes && !['cover', 'contain', 'scale-down'].includes(objectFit)) {
      return null;
    }
    if (!img.getClientRects().length) {
      return 0;
    }

    let width = parseFloat(style.width);
    let height = parseFloat(style.height);
    if (style.boxSizing === 'border-box') {
      width -= parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
        + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      height -= parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
        + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    }

    // Use the dimension attributes as the source aspect ratio before loading.
    const sourceWidth = parseInt(img.getAttribute('width'), 10);
    const sourceHeight = parseInt(img.getAttribute('height'), 10);
    const aspectRatio = sourceWidth / sourceHeight;
    if (!(width > 0 && height > 0 && sourceWidth > 0 && sourceHeight > 0)
      || !Number.isFinite(aspectRatio)) {
      return hasNativeAutoSizes ? null : width;
    }

    const fittedWidth = height * aspectRatio;
    let adjustedWidth = width;
    if (objectFit === 'cover') {
      adjustedWidth = Math.max(width, fittedWidth);
    } else if (objectFit === 'contain' || objectFit === 'scale-down') {
      adjustedWidth = Math.min(width, fittedWidth);
    }
    return hasNativeAutoSizes && adjustedWidth === width ? null : adjustedWidth;
  }

  function calculateSizes(img) {
    let width = getImageSourceWidth(img);
    if (!hasNativeAutoSizes && !(width > 0)) {
      width = img.parentElement?.getBoundingClientRect().width;
    }
    return width > 0 && Number.isFinite(width) ? `${width}px` : null;
  }

  // Store the original src and srcset attributes, and remove them to prevent loading before
  // we've calculated the sizes attribute
  function preventNonAutoImageLoad(images) {
    const measuredSizes = new Map();
    for (const img of images) {
      if (!hasNativeAutoSizes && img.complete) {
        // Don't do any of this if the image is already loaded
        continue;
      }
      // Only process images with sizes attribute starting with "auto" and loading="lazy"
      if (hasNativeAutoSizes ? !canCorrectNativeSizing(img) : !isLazyAutoSized(img)) {
        continue;
      }
      if (!didFirstContentfulPaintRun) {
        if (hasNativeAutoSizes) {
          deferredImages.set(img, null);
          continue;
        }
        // Merge with any values stored by a previous pass over this image
        const originalAttributes =
          deferredImages.get(img) || Object.create(null);
        for (const attribute of attributes) {
          if (img.hasAttribute(attribute)) {
            // Store original src and srcset
            originalAttributes[attribute] = img.getAttribute(attribute);
            // Remove src and srcset to prevent loading
            img.removeAttribute(attribute);
          }
        }
        deferredImages.set(img, originalAttributes);
      } else {
        // Calculate sizes without removing src and srcset
        if (!measuredSizes.has(img)) {
          measuredSizes.set(img, calculateSizes(img));
        }
      }
    }
    for (const [img, sizes] of measuredSizes) {
      if (sizes) {
        img.sizes = sizes;
      }
    }
  }

  // Set the sizes attribute to the computed width in pixels and restore original src and srcset
  function restoreImageAttributes() {
    // Read every image's layout before changing sizes or restoring sources.
    const measuredSizes = Array.from(deferredImages.keys(), (img) => [
      img,
      !hasNativeAutoSizes || canCorrectNativeSizing(img) ? calculateSizes(img) : null,
    ]);
    for (const [img, sizes] of measuredSizes) {
      if (sizes) {
        img.sizes = sizes;
      }

      const originalAttributes = deferredImages.get(img);
      for (const attribute of attributes) {
        if (originalAttributes && attribute in originalAttributes) {
          img[attribute] = originalAttributes[attribute];
        }
      }
    }
    deferredImages.clear();
  }

  // Set up mutation observer to detect new images
  const observer = new MutationObserver((mutations) => {
    const newImages = [];

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeName === 'IMG') {
            newImages.push(node);
          }
          // Add all images within added nodes
          if (node.querySelectorAll) {
            newImages.push(...node.querySelectorAll('img'));
          }
        }
      }
      // Check for attribute changes on images
      else if (
        mutation.type === 'attributes' &&
        mutation.target.nodeName === 'IMG' &&
        (mutation.attributeName === 'sizes' ||
          mutation.attributeName === 'loading' ||
          mutation.attributeName === 'src' ||
          mutation.attributeName === 'srcset')
      ) {
        newImages.push(mutation.target);
      }
    }

    if (newImages.length > 0) {
      preventNonAutoImageLoad(newImages);
    }
  });

  // Start observing the document
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['sizes', 'loading'],
  });

  // Prevent the load of any existing images when the polyfill loads.
  preventNonAutoImageLoad(
    document.querySelectorAll('img[sizes^="auto" i][loading="lazy" i]'),
  );

  new PerformanceObserver((entries, observer) => {
    entries.getEntriesByName('first-contentful-paint').forEach(() => {
      didFirstContentfulPaintRun = true;
      setTimeout(restoreImageAttributes, 0);
      observer.disconnect();
    });
  }).observe({type: 'paint', buffered: true});
})();
