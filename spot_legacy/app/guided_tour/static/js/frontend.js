const spotModalLoadingId = '#spot-modal-loading';
const spotModalResponseId = '#spot-modal-response';
const spotModalResponseHeaderId = '#spot-modal-response-header';
const spotModalResponseTextId = '#spot-modal-response-text';
const mainUI = '#main_ui';

function request(url) {
  $(mainUI).hide();
  $(spotModalLoadingId).show();
  $.ajax({
    type: 'POST',
    url: url,
    success: function (response, textStatus, xhr) {
      $(mainUI).show();
      $(spotModalLoadingId).hide();
      if (xhr.status == 201) {
        displayResponseModal(response, "bg-primary", "Info");
      }
    },
    error: function (xhr) {
      let msg = xhr.responseText;
      console.error(msg);
      $(mainUI).show();
      $(spotModalLoadingId).hide();
      if (msg.includes("timeout")) {
        msg = "Can't reach Spot.";
      }
      displayResponseModal(msg, "bg-danger", "Error");
    }
  });
}

function displayResponseModal(msg, headerclass, title) {
  $(spotModalResponseTextId).html(msg);
  $(spotModalResponseHeaderId).removeClass().addClass("modal-header").addClass(headerclass);
  $(spotModalResponseHeaderId + " h5").html(title);
  $(spotModalResponseId).modal("show");
}

function show_map_modal() {
  $.ajax({
    type: 'GET',
    url: "/map",
    success: function (response, textStatus, xhr) {
      $("#current_map_code").html(response)
    },
    error: function (xhr) {
      let msg = xhr.responseText;
      $("#map_modal").modal().hide();
      displayResponseModal(msg, "bg-danger", "Error");
    }
  });
  $("#map_modal").modal().show();
}

function set_map_code(map_code) {
  $.ajax({
    type: 'POST',
    url: "/map",
    contentType: 'text/plain',
    data: map_code,
    success: function (response, textStatus, xhr) {
      $("#map_modal").modal().hide();
    },
    error: function (xhr) {
      let msg = xhr.responseText;
      $("#map_modal").modal().hide();
      displayResponseModal(msg, "bg-danger", "Error");
    }
  });
}

function close_modal(modal_id) {
  $("#" + modal_id).modal().hide();
}