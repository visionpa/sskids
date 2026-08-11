import wixData from 'wix-data';
let latestQueryId = 0; // to avoid race conditions

$w.onReady(function () {
    $w("#table1").hide(); // keep hidden until rows are ready
    
    // Define table columns
    $w("#table1").columns = [
        { id: "firstName", dataPath: "firstName", label: "First Name", type: "string" },
        { id: "lastName", dataPath: "lastName", label: "Last Name", type: "string" },
        { id: "pickup", dataPath: "pickup", label: "Pickup", type: "string" },
        { id: "grade", dataPath: "grade", label: "Grade", type: "string" },
        { id: "schoolTitle", dataPath: "schoolTitle", label: "School", type: "string" }, // new column
        { id: "updatedDate", dataPath: "updatedDate", label: "Updated Date", type: "string" }
    ];
    
    // Load all data initially
    loadAllData();
    
    // Search button
    $w("#searchButton").onClick(() => {
        // Immediately show loading and hide table
        $w("#loadingText").show();
        $w("#table1").hide();
        
        // Then run the search
        searchByFirstName();
    });
    
    // Clear button
    $w("#clearButton").onClick(() => {
        $w("#codeInput").value = "";
        loadAllData();
    });
    
    // Search on Enter
    $w("#codeInput").onKeyPress((event) => {
        if (event.key === "Enter") {
            $w("#loadingText").show();
            $w("#table1").hide();
            
            searchByFirstName();
        }
    });
    
    // Toggle pickup on row select
    $w("#table1").onRowSelect((event) => {
        const rowData = $w("#table1").rows[event.rowIndex];
        let newPickupValue = rowData.pickup === "Yes" ? false : true;
        
        // Optimistically update the UI first
        const updatedRows = $w("#table1").rows.map(row =>
            row._id === rowData._id ? { ...rowData, pickup: newPickupValue ? "Yes" : "No" } : row
        );
        $w("#table1").rows = updatedRows;
        
        // Fetch the full item and update only the pickup field
        wixData.get("Items", rowData._id)
            .then(fullItem => {
                fullItem.pickup = newPickupValue;
                return wixData.update("Items", fullItem);
            })
            .then(updatedItem => {
                // Fetch the full updated item to ensure all fields are included
                return wixData.get("Items", updatedItem._id);
            })
            .then(fullUpdatedItem => {
                // Map the updated item to table rows and refresh the UI
                const mappedRows = mapItemsToTable([fullUpdatedItem]);
                const updatedRows = $w("#table1").rows.map(row =>
                    row._id === fullUpdatedItem._id ? mappedRows[0] : row
                );
                $w("#table1").rows = updatedRows;
            })
            .catch(err => {
                console.error("Error updating pickup:", err);
                // Revert the UI change if the update fails
                const revertedRows = $w("#table1").rows.map(row =>
                    row._id === rowData._id ? { ...rowData, pickup: rowData.pickup } : row
                );
                $w("#table1").rows = revertedRows;
            });
    });
});

// Compare dates in PST
function isSameDayPST(date1, date2) {
    let pstDate1 = new Date(date1.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    let pstDate2 = new Date(date2.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    
    return pstDate1.getFullYear() === pstDate2.getFullYear() &&
           pstDate1.getMonth() === pstDate2.getMonth() &&
           pstDate1.getDate() === pstDate2.getDate();
}

// Safe row setter to avoid race conditions
function safeSetRows(promise) {
    const id = ++latestQueryId;
    $w("#loadingText").show(); // "Loading..." message
    
    promise.then(items => mapItemsToTable(items)) // expand references
        .then(mappedRows => {
            if (id === latestQueryId) {
                $w("#table1").rows = mappedRows;
                $w("#loadingText").hide();
                $w("#table1").show(); // ✅ show only when fully ready
            }
        })
        .catch(err => {
            console.error("Error setting rows:", err);
            $w("#loadingText").hide();
        });
}

// Load all data and auto-reset pickups older than today (PST)
function loadAllData() {
    safeSetRows(
        wixData.query("Items")
            .limit(1000)
            .ascending("title")
            .find()
            .then(results => {
                let now = new Date();
                let updatePromises = results.items.map(item => {
                    if (item.pickup && item._updatedDate) {
                        let itemDate = new Date(item._updatedDate);
                        if (!isSameDayPST(itemDate, now)) {
                            item.pickup = false;
                            return wixData.update("Items", item)
                                .then(updatedItem => updatedItem)
                                .catch(err => console.error("Error updating pickup:", err));
                        }
                    }
                    return Promise.resolve(item);
                });
                return Promise.all(updatePromises);
            })
    );
}

// Enhanced search by firstName (title in Items), lastName, or school reference (title in School)
function searchByFirstName() {
    let searchValue = $w("#codeInput").value.trim();
    if (!searchValue) return loadAllData();

    wixData.query("Items")
        .contains("title", searchValue) // firstName
        .or(wixData.query("Items").contains("lastName", searchValue)) // lastName
        .limit(1000)
        .find()
        .then(results => {
            if (results.items.length > 0) {
                safeSetRows(Promise.resolve(Array.from(new Set(results.items.map(item => item._id))).map(id => results.items.find(item => item._id === id))));
                return;
            }

            wixData.query("school")
                .contains("title", searchValue) // school title
                .find()
                .then(schoolResults => {
                    const schoolIds = schoolResults.items.map(s => s._id);
                    if (schoolIds.length > 0) {
                        return wixData.query("Items")
                            .hasSome("schoolName", schoolIds) // reference match
                            .ascending("title") // sort by firstName (stored in title)
                            .limit(1000)
                            .find();
                    }
                    return Promise.resolve({ items: [] });
                })
                .then(results => {
                    safeSetRows(Promise.resolve(Array.from(new Set(results.items.map(item => item._id))).map(id => results.items.find(item => item._id === id))));
                })
                .catch(err => console.error("Search error:", err));
        })
        .catch(err => console.error("Search error:", err));
}

// Map database items to table rows
function mapItemsToTable(items) {
    return Promise.all(items.map(item => {
        if (item.schoolName) {
            return wixData.get("school", item.schoolName)
                .then(school => ({
                    _id: item._id,
                    firstName: item.title || "",
                    lastName: item.lastName || "",
                    pickup: item.pickup ? "Yes" : "No",
                    grade: item.grade || "",
                    schoolTitle: school ? school.title : "", // show school title
                    updatedDate: item._updatedDate ?
                        new Date(item._updatedDate).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" }) :
                        ""
                }));
        } else {
            return Promise.resolve({
                _id: item._id,
                firstName: item.title || "",
                lastName: item.lastName || "",
                pickup: item.pickup ? "Yes" : "No",
                grade: item.grade || "",
                schoolTitle: "", // no school reference
                updatedDate: item._updatedDate ?
                    new Date(item._updatedDate).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" }) :
                    ""
            });
        }
    }));
}