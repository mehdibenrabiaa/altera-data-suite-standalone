import { InputNumber } from "antd";

import previousPageIcon from "../../public/previous-page.svg";
import nextPageIcon from "../../public/next-page.svg";

interface PageNavPanelProps {
  pdfDoc: any;
  pageNum: number;
  numPages: number;
  handlePrevPage: () => void;
  handleNextPage: () => void;
  showPageInput: boolean;
  setShowPageInput: (v: boolean) => void;
  pageInputValue: number | null;
  setPageInputValue: (v: number | null) => void;
  handleGoToPage: () => void;
}

export default function PageNavPanel({
  pdfDoc,
  pageNum,
  numPages,
  handlePrevPage,
  handleNextPage,
  showPageInput,
  setShowPageInput,
  pageInputValue,
  setPageInputValue,
  handleGoToPage,
}: PageNavPanelProps) {
  if (!pdfDoc) {
    return <div className="page-nav-panel-body page-nav-empty">No PDF loaded</div>;
  }

  return (
    <div className="page-nav-panel-body">
      <button
        className={`toolbar-btn page-nav-arrow ${pageNum <= 1 ? "nav-btn-disabled" : ""}`}
        onClick={handlePrevPage}
        disabled={pageNum <= 1}
        title="Previous Page"
      >
        <img src={previousPageIcon} alt="Previous" />
      </button>
      <div className="page-nav-wrapper">
        <button
          onClick={() => setShowPageInput(!showPageInput)}
          className="page-indicator"
          title={`${pageNum} / ${numPages}`}
        >
          {pageNum} / {numPages}
        </button>

        {showPageInput && (
          <div className="go-to-page-wrapper">
            <div className="go-to-page-title">Go to page:</div>
            <div className="go-to-page-input-group">
              <InputNumber
                min={1}
                max={numPages}
                value={pageInputValue}
                onChange={(v) => setPageInputValue(v)}
                onPressEnter={handleGoToPage}
                placeholder={`1-${numPages}`}
                autoFocus
                size="small"
                style={{ width: 65 }}
              />
              <button onClick={handleGoToPage} className="toolbar-btn go-to-page-btn">
                Go
              </button>
            </div>
          </div>
        )}
      </div>

      <button
        className={`toolbar-btn page-nav-arrow ${pageNum === numPages ? "nav-btn-disabled" : ""}`}
        onClick={handleNextPage}
        disabled={pageNum === numPages}
        title="Next Page"
      >
        <img src={nextPageIcon} alt="Next" />
      </button>
    </div>
  );
}
