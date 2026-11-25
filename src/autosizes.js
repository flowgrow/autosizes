(function () {
  // Check if the browser already supports sizes="auto"
  // We're using UA sniffing here, as there's no way to detect browser
  // support without a forced layout, which would make things slower for everyone.
  const polyfillAutoSizes = () => {
    // Avoid polyfilling if the browser is too old and doesn't support performance observer and paint timing
    if (
      !('PerformanceObserver' in window) ||
      !PerformanceObserver.supportedEntryTypes.includes('paint')
    ) {
      return false;
    }

    const userAgent = navigator.userAgent;
    const chromeMatch = userAgent.match(/Chrome\/(\d+)/);

    if (!chromeMatch) {
      return true;
    }

    const chromeVersion = parseInt(chromeMatch[1], 10);
    return chromeVersion < 126;
  };

  if (!polyfillAutoSizes()) {
    return;
  }

  const attributes = ['src', 'srcset'];
  // The original src and srcset values of images whose loading we deferred, keyed by element.
  // These are kept in memory rather than in the DOM (e.g. in data-* attributes), so that only
  // values the polyfill itself removed can ever be restored. Otherwise, page content carrying
  // such attributes (e.g. sanitized user HTML that strips src but keeps data-* attributes)
  // could get the polyfill to load arbitrary URLs.
  const deferredImages = new Map();
  let didFirstContentfulPaintRun = false;

  function getImageSourceWidth(img) {
    if (!img.getClientRects().length) {
      return 0;
    }

    const style = getComputedStyle(img);
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
      return width;
    }

    const fittedWidth = height * aspectRatio;
    if (style.objectFit === 'cover') {
      return Math.max(width, fittedWidth);
    }
    if (style.objectFit === 'contain' || style.objectFit === 'scale-down') {
      return Math.min(width, fittedWidth);
    }
    return width;
  }

  function calculateSizes(img) {
    let width = getImageSourceWidth(img);
    if (!(width > 0)) {
      width = img.parentElement?.getBoundingClientRect().width;
    }
    return width > 0 && Number.isFinite(width) ? `${width}px` : null;
  }

  // Store the original src and srcset attributes, and remove them to prevent loading before
  // we've calculated the sizes attribute
  function preventNonAutoImageLoad(images) {
    const measuredSizes = new Map();
    for (const img of images) {
      if (img.complete) {
        // Don't do any of this if the image is already loaded
        continue;
      }
      // Only process images with sizes attribute starting with "auto" and loading="lazy"
      if (
        !(img.getAttribute('sizes') || '').trim().startsWith('auto') ||
        img.getAttribute('loading') !== 'lazy'
      ) {
        continue;
      }
      if (!didFirstContentfulPaintRun) {
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
      calculateSizes(img),
    ]);
    for (const [img, sizes] of measuredSizes) {
      if (sizes) {
        img.sizes = sizes;
      }

      const originalAttributes = deferredImages.get(img);
      for (const attribute of attributes) {
        if (attribute in originalAttributes) {
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
    document.querySelectorAll('img[sizes^="auto"][loading="lazy"]'),
  );

  new PerformanceObserver((entries, observer) => {
    entries.getEntriesByName('first-contentful-paint').forEach(() => {
      didFirstContentfulPaintRun = true;
      setTimeout(restoreImageAttributes, 0);
      observer.disconnect();
    });
  }).observe({type: 'paint', buffered: true});
})();
